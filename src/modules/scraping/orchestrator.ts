import { Cron } from 'croner';
import {
    and,
    eq,
    gt,
    inArray,
    isNotNull,
    isNull,
    lte,
    notInArray,
    or,
    sql,
} from 'drizzle-orm';
import {
    type EventInsert,
    type EventItem,
    events,
    type ReportInsert,
    type ReportItem,
    reports,
} from '../../core/schema.js';
import type { AlertDispatcher } from '../../infrastructure/alerting/dispatcher.js';
import type { DbOrTx } from '../../infrastructure/database/db.js';
import { logger } from '../../infrastructure/logging/logger.js';
import type { ScrapingStrategy } from './strategy.interface.js';

export class ScrapingOrchestrator {
    private readonly db: DbOrTx;
    private readonly strategies: ScrapingStrategy[];
    private readonly dispatcher: AlertDispatcher;
    private readonly jobs: Cron[] = [];

    constructor(
        db: DbOrTx,
        strategies: ScrapingStrategy[],
        dispatcher: AlertDispatcher,
    ) {
        this.db = db;
        this.strategies = strategies;
        this.dispatcher = dispatcher;
    }

    start(): void {
        for (const strategy of this.strategies) {
            const job = new Cron(
                strategy.schedule,
                { protect: true },
                async () => {
                    await this.run(strategy);
                },
            );
            this.jobs.push(job);
            job.trigger();
        }

        const reconcileJob = new Cron(
            '*/15 * * * *',
            { protect: true },
            async () => {
                try {
                    logger.info('[Worker:reconciler] reconciling...');

                    const entries = await this.db.transaction(async (tx) => {
                        const r = await this.reconcileTable(tx, reports);
                        const e = await this.reconcileTable(tx, events);
                        return {
                            r,
                            e,
                        };
                    });

                    const started = [
                        ...entries.r.started,
                        ...entries.e.started,
                    ];
                    const ended = [...entries.r.ended, ...entries.e.ended];
                    const unknown = [
                        ...entries.r.unknown,
                        ...entries.e.unknown,
                    ];

                    logger.info(
                        `[Worker:reconciler] transitioned ${started.length} ${started.length === 1 ? 'entry' : 'entries'} to ongoing, ${ended.length} ${ended.length === 1 ? 'entry' : 'entries'} to ended, and ${unknown.length} ${unknown.length === 1 ? 'entry' : 'entries'} to unknown.`,
                    );

                    if (started.length > 0) {
                        const bySource = Map.groupBy(
                            started,
                            (item) => item.source,
                        );

                        for (const [source, items] of bySource) {
                            await this.dispatcher.dispatch(source, items);
                        }
                    }
                } catch (error) {
                    logger.error(
                        '[Worker:reconciler] status reconciliation failed:\n%O',
                        error,
                    );
                }
            },
        );
        this.jobs.push(reconcileJob);
    }

    stop(): void {
        for (const job of this.jobs) {
            job.stop();
        }
        this.jobs.length = 0;
    }

    async run(strategy: ScrapingStrategy): Promise<void> {
        try {
            logger.info(`[Worker:${strategy.source}] fetching...`);
            const raw = await strategy.fetch();

            logger.info(`[Worker:${strategy.source}] parsing...`);
            const entries = await strategy.parse(raw);

            logger.info(
                `[Worker:${strategy.source}] found ${entries.length} entries.`,
            );

            if (entries.length > 0) {
                const inserted = await this.insert(strategy, entries);

                if (inserted.length > 0) {
                    logger.info(
                        `[Worker:${strategy.source}] inserted ${inserted.length} new entries.`,
                    );

                    const alertable = inserted.filter(
                        (item) => item.status === 'ongoing',
                    );
                    if (alertable.length > 0) {
                        await this.dispatcher.dispatch(
                            strategy.source,
                            alertable,
                        );
                    }
                } else {
                    logger.info(
                        `[Worker:${strategy.source}] no new entries to insert.`,
                    );
                }
            }
        } catch (error) {
            logger.error(`[Worker:${strategy.source}] failed:\n%O`, error);
        }
    }

    private async insert(
        strategy: ScrapingStrategy,
        rows: Array<ReportInsert | EventInsert>,
    ): Promise<Array<ReportItem | EventItem>> {
        return await this.db.transaction(async (tx) => {
            if (strategy.target === 'reports') {
                const uniqueMap = new Map<string, ReportInsert>();
                for (const row of rows as ReportInsert[]) {
                    uniqueMap.set(row.externalId, row);
                }
                const reportRows = Array.from(uniqueMap.values());
                const externalIds = reportRows.map((r) => r.externalId);

                const existing = await tx
                    .select({
                        externalId: reports.externalId,
                        status: reports.status,
                    })
                    .from(reports)
                    .where(
                        and(
                            eq(reports.source, strategy.source),
                            inArray(reports.externalId, externalIds),
                        ),
                    );

                const existingMap = new Map(
                    existing.map((e) => [e.externalId, e.status]),
                );
                // Newly arrived = brand-new id, or an id previously ended that re-opens today.
                const isNewlyArrived = (row: {
                    externalId: string;
                    status: string;
                    endsAt?: Date | null | undefined;
                }): boolean =>
                    !existingMap.has(row.externalId) ||
                    (strategy.stateFeed === true &&
                        existingMap.get(row.externalId) === 'ended' &&
                        row.status !== 'ended' &&
                        !row.endsAt);

                const alreadyOngoingLocations = new Set<string>();

                if (strategy.stateFeed) {
                    const supersededLocations = Array.from(
                        new Set(
                            reportRows
                                .filter(
                                    (r) =>
                                        isNewlyArrived(r) &&
                                        !r.endsAt &&
                                        Boolean(r.locationLabel),
                                )
                                .map((r) => r.locationLabel as string),
                        ),
                    );

                    if (supersededLocations.length > 0) {
                        const supersededRows = await tx
                            .select({
                                id: reports.id,
                                locationLabel: reports.locationLabel,
                                status: reports.status,
                            })
                            .from(reports)
                            .where(
                                and(
                                    eq(reports.source, strategy.source),
                                    inArray(reports.status, [
                                        'ongoing',
                                        'omitted',
                                    ]),
                                    isNull(reports.endsAt),
                                    notInArray(reports.externalId, externalIds),
                                    inArray(
                                        reports.locationLabel,
                                        supersededLocations,
                                    ),
                                ),
                            );

                        if (supersededRows.length > 0) {
                            await tx
                                .update(reports)
                                .set({
                                    status: 'ended',
                                    endsAt: sql`now()`,
                                    updatedAt: sql`now()`,
                                })
                                .where(
                                    inArray(
                                        reports.id,
                                        supersededRows.map((r) => r.id),
                                    ),
                                );

                            for (const row of supersededRows) {
                                if (
                                    row.status === 'ongoing' &&
                                    row.locationLabel
                                ) {
                                    alreadyOngoingLocations.add(
                                        row.locationLabel,
                                    );
                                }
                            }
                        }
                    }
                }

                // Same-day re-open: incoming open-ended state row supersedes an ended row
                // under the same daily externalId.
                const reopens = sql`excluded.status != 'ended' AND excluded.ends_at IS NULL AND ${reports.status} = 'ended'`;
                const conflictSet = strategy.stateFeed
                    ? {
                          observedAt: sql`excluded.observed_at`,
                          startsAt: sql`CASE WHEN ${reopens} THEN excluded.starts_at ELSE ${reports.startsAt} END`,
                          endsAt: sql`CASE WHEN ${reopens} THEN NULL ELSE coalesce(excluded.ends_at, ${reports.endsAt}) END`,
                          title: sql`CASE WHEN ${reopens} THEN excluded.title ELSE ${reports.title} END`,
                          description: sql`CASE WHEN ${reopens} THEN excluded.description ELSE ${reports.description} END`,
                          rawPayload: sql`CASE WHEN ${reopens} THEN excluded.raw_payload ELSE ${reports.rawPayload} END`,
                          status: sql`CASE WHEN excluded.status = 'ended' THEN 'ended'::lifecycle_status WHEN ${reopens} THEN excluded.status ELSE ${reports.status} END`,
                          updatedAt: sql`CASE WHEN excluded.status = 'ended' AND ${reports.status} != 'ended' THEN now() WHEN ${reopens} THEN now() ELSE ${reports.updatedAt} END`,
                      }
                    : {
                          observedAt: sql`excluded.observed_at`,
                          endsAt: sql`coalesce(excluded.ends_at, ${reports.endsAt})`,
                          status: sql`CASE WHEN excluded.status = 'ended' THEN 'ended'::lifecycle_status ELSE ${reports.status} END`,
                          updatedAt: sql`CASE WHEN excluded.status = 'ended' AND ${reports.status} != 'ended' THEN now() ELSE ${reports.updatedAt} END`,
                      };

                const savedRows = await tx
                    .insert(reports)
                    .values(reportRows)
                    .onConflictDoUpdate({
                        target: [reports.source, reports.externalId],
                        set: conflictSet,
                    })
                    .returning();

                return savedRows.filter(
                    (row) =>
                        isNewlyArrived(row) &&
                        !(
                            row.locationLabel &&
                            alreadyOngoingLocations.has(row.locationLabel)
                        ),
                );
            }

            const uniqueMap = new Map<string, EventInsert>();
            for (const row of rows as EventInsert[]) {
                uniqueMap.set(row.externalId, row);
            }
            const eventRows = Array.from(uniqueMap.values());
            const externalIds = eventRows.map((r) => r.externalId);

            const existing = await tx
                .select({
                    externalId: events.externalId,
                    status: events.status,
                })
                .from(events)
                .where(
                    and(
                        eq(events.source, strategy.source),
                        inArray(events.externalId, externalIds),
                    ),
                );

            const existingMap = new Map(
                existing.map((e) => [e.externalId, e.status]),
            );
            // Newly arrived = brand-new id, or an id previously ended that re-opens today.
            const isNewlyArrived = (row: {
                externalId: string;
                status: string;
                endsAt?: Date | null | undefined;
            }): boolean =>
                !existingMap.has(row.externalId) ||
                (strategy.stateFeed === true &&
                    existingMap.get(row.externalId) === 'ended' &&
                    row.status !== 'ended' &&
                    !row.endsAt);

            const hasNewOpenEnded = eventRows.some(
                (r) => isNewlyArrived(r) && !r.endsAt,
            );

            if (strategy.stateFeed && hasNewOpenEnded) {
                await tx
                    .update(events)
                    .set({
                        status: 'ended',
                        endsAt: sql`now()`,
                        updatedAt: sql`now()`,
                    })
                    .where(
                        and(
                            eq(events.source, strategy.source),
                            eq(events.category, strategy.category),
                            inArray(events.status, ['ongoing', 'omitted']),
                            isNull(events.endsAt),
                            notInArray(events.externalId, externalIds),
                        ),
                    );
            }

            // Same-day re-open: incoming open-ended state row supersedes an ended row
            // under the same daily externalId.
            const reopens = sql`excluded.status != 'ended' AND excluded.ends_at IS NULL AND ${events.status} = 'ended'`;
            const conflictSet = strategy.stateFeed
                ? {
                      observedAt: sql`excluded.observed_at`,
                      startsAt: sql`CASE WHEN ${reopens} THEN excluded.starts_at ELSE ${events.startsAt} END`,
                      endsAt: sql`CASE WHEN ${reopens} THEN NULL ELSE coalesce(excluded.ends_at, ${events.endsAt}) END`,
                      title: sql`CASE WHEN ${reopens} THEN excluded.title ELSE ${events.title} END`,
                      description: sql`CASE WHEN ${reopens} THEN excluded.description ELSE ${events.description} END`,
                      rawPayload: sql`CASE WHEN ${reopens} THEN excluded.raw_payload ELSE ${events.rawPayload} END`,
                      status: sql`CASE WHEN excluded.status = 'ended' THEN 'ended'::lifecycle_status WHEN ${reopens} THEN excluded.status ELSE ${events.status} END`,
                      updatedAt: sql`CASE WHEN excluded.status = 'ended' AND ${events.status} != 'ended' THEN now() WHEN ${reopens} THEN now() ELSE ${events.updatedAt} END`,
                  }
                : {
                      observedAt: sql`excluded.observed_at`,
                      endsAt: sql`coalesce(excluded.ends_at, ${events.endsAt})`,
                      status: sql`CASE WHEN excluded.status = 'ended' THEN 'ended'::lifecycle_status ELSE ${events.status} END`,
                      updatedAt: sql`CASE WHEN excluded.status = 'ended' AND ${events.status} != 'ended' THEN now() ELSE ${events.updatedAt} END`,
                  };

            const savedRows = await tx
                .insert(events)
                .values(eventRows)
                .onConflictDoUpdate({
                    target: [events.source, events.externalId],
                    set: conflictSet,
                })
                .returning();

            return savedRows.filter((row) => isNewlyArrived(row));
        });
    }

    private async reconcileTable(
        tx: DbOrTx,
        table: typeof reports | typeof events,
    ): Promise<{
        started: Array<ReportItem | EventItem>;
        ended: Array<ReportItem | EventItem>;
        unknown: Array<ReportItem | EventItem>;
    }> {
        const now = new Date();
        const staleThreshold = new Date(now.getTime() - 24 * 60 * 60 * 1000);

        const ended = await tx
            .update(table)
            .set({
                status: 'ended',
                updatedAt: now,
            })
            .where(
                and(
                    inArray(table.status, ['scheduled', 'ongoing', 'omitted']),
                    isNotNull(table.endsAt),
                    lte(table.endsAt, now),
                ),
            )
            .returning();

        const started = await tx
            .update(table)
            .set({ status: 'ongoing', updatedAt: now })
            .where(
                and(
                    eq(table.status, 'scheduled'),
                    isNotNull(table.startsAt),
                    lte(table.startsAt, now),
                    or(isNull(table.endsAt), gt(table.endsAt, now)),
                ),
            )
            .returning();

        const unknown = await tx
            .update(table)
            .set({ status: 'unknown', updatedAt: now })
            .where(
                and(
                    inArray(table.status, ['ongoing', 'omitted']),
                    isNull(table.endsAt),
                    lte(table.observedAt, staleThreshold),
                ),
            )
            .returning();

        return {
            started,
            ended,
            unknown,
        };
    }
}
