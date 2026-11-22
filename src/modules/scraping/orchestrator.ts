import { Cron } from 'croner';
import {
    and,
    eq,
    gt,
    inArray,
    isNotNull,
    isNull,
    lte,
    or,
    sql,
} from 'drizzle-orm';
import type PQueue from 'p-queue';
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

type ExistingRowState = { status: string; endsAt: Date | null };

type Partition<T> = {
    toInsert: T[];
    skipped: T[];
    toTransition: T[];
    toHeartbeat: T[];
};

function stripEpisodeSuffix(externalId: string): string {
    return externalId.replace(/#\d+$/, '');
}

function partitionRows<
    T extends {
        externalId: string;
        status: string;
        endsAt?: Date | null | undefined;
    },
>(rows: T[], existingMap: Map<string, ExistingRowState>): Partition<T> {
    const partition: Partition<T> = {
        toInsert: [],
        skipped: [],
        toTransition: [],
        toHeartbeat: [],
    };

    for (const row of rows) {
        const prev = existingMap.get(row.externalId);
        if (!prev) {
            partition.toInsert.push(row);
        } else if (
            prev.status === 'ended' &&
            row.status === 'ended' &&
            (!row.endsAt || prev.endsAt !== null)
        ) {
            partition.skipped.push(row);
        } else if (
            (row.status === 'ended' && prev.status !== 'ended') ||
            (row.endsAt != null && prev.endsAt === null)
        ) {
            partition.toTransition.push(row);
        } else {
            partition.toHeartbeat.push(row);
        }
    }

    return partition;
}

export class ScrapingOrchestrator {
    private readonly db: DbOrTx;
    private readonly strategies: ScrapingStrategy[];
    private readonly dispatcher: AlertDispatcher;
    private readonly queue: PQueue;
    private readonly jobs: Cron[] = [];

    constructor(
        db: DbOrTx,
        strategies: ScrapingStrategy[],
        dispatcher: AlertDispatcher,
        queue: PQueue,
    ) {
        this.db = db;
        this.strategies = strategies;
        this.dispatcher = dispatcher;
        this.queue = queue;
    }

    start(): void {
        for (const strategy of this.strategies) {
            const job = new Cron(
                strategy.schedule,
                { protect: true },
                async () => {
                    try {
                        await this.queue.add(() => this.run(strategy));
                    } catch {
                        // queue.clear() aborts queued tasks during shutdown
                    }
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
        this.queue.clear();
        for (const job of this.jobs) {
            job.stop();
        }
        this.jobs.length = 0;
    }

    async run(strategy: ScrapingStrategy): Promise<void> {
        const startedAt = performance.now();
        try {
            const raw = await strategy.fetch();
            const entries = await strategy.parse(raw);

            let inserted = 0;
            let updated = 0;
            let skipped = 0;

            if (entries.length > 0) {
                const result = await this.insert(strategy, entries);
                inserted = result.inserted.length;
                updated = result.updated;
                skipped = result.skipped;

                const alertable = result.inserted.filter(
                    (item) => item.status === 'ongoing',
                );
                if (alertable.length > 0) {
                    await this.dispatcher.dispatch(strategy.source, alertable);
                }
            }

            const durationMs = Math.round(performance.now() - startedAt);
            logger.info(
                `[Worker:${strategy.source}] done in ${durationMs}ms (found=${entries.length}, inserted=${inserted}, updated=${updated}, skipped=${skipped}).`,
            );
        } catch (error) {
            logger.error(`[Worker:${strategy.source}] failed:\n%O`, error);
        }
    }

    private async insert(
        strategy: ScrapingStrategy,
        rows: Array<ReportInsert | EventInsert>,
    ): Promise<{
        inserted: Array<ReportItem | EventItem>;
        updated: number;
        skipped: number;
    }> {
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
                        endsAt: reports.endsAt,
                    })
                    .from(reports)
                    .where(
                        and(
                            eq(reports.source, strategy.source),
                            inArray(reports.externalId, externalIds),
                        ),
                    );

                const existingMap = new Map<string, ExistingRowState>(
                    existing.map((e) => [
                        e.externalId,
                        { status: e.status, endsAt: e.endsAt },
                    ]),
                );
                const now = new Date();
                const supersededIdsToEnd = new Set<number>();
                const alreadyOngoingLocations = new Set<string>();
                const episodeInserts: ReportInsert[] = [];
                const heartbeatRowIds = new Set<number>();

                const stateFeed = strategy.stateFeed === true;
                const episodeRows = stateFeed
                    ? reportRows.filter(
                          (r) =>
                              !r.endsAt &&
                              r.status !== 'ended' &&
                              Boolean(r.locationLabel),
                      )
                    : [];
                const episodeSet = new Set(episodeRows);
                const remainder = reportRows.filter((r) => !episodeSet.has(r));
                const incomingLocations = Array.from(
                    new Set(
                        episodeRows
                            .map((r) => r.locationLabel)
                            .filter((label): label is string => Boolean(label)),
                    ),
                );
                const { toInsert, skipped, toTransition, toHeartbeat } =
                    partitionRows(remainder, existingMap);

                if (incomingLocations.length > 0) {
                    const activeRows = await tx
                        .select({
                            id: reports.id,
                            externalId: reports.externalId,
                            locationLabel: reports.locationLabel,
                            status: reports.status,
                        })
                        .from(reports)
                        .where(
                            and(
                                eq(reports.source, strategy.source),
                                inArray(reports.status, ['ongoing', 'omitted']),
                                isNull(reports.endsAt),
                                inArray(
                                    reports.locationLabel,
                                    incomingLocations,
                                ),
                            ),
                        );

                    const activeByLocation = new Map<
                        string,
                        typeof activeRows
                    >();
                    for (const active of activeRows) {
                        if (!active.locationLabel) continue;
                        const group =
                            activeByLocation.get(active.locationLabel) ?? [];
                        group.push(active);
                        activeByLocation.set(active.locationLabel, group);
                    }

                    for (const row of episodeRows) {
                        const location = row.locationLabel as string;
                        const actives = activeByLocation.get(location) ?? [];
                        const match = actives.find(
                            (active) =>
                                stripEpisodeSuffix(active.externalId) ===
                                row.externalId,
                        );
                        if (match) {
                            heartbeatRowIds.add(match.id);
                            continue;
                        }
                        for (const active of actives) {
                            supersededIdsToEnd.add(active.id);
                            if (active.status === 'ongoing') {
                                alreadyOngoingLocations.add(location);
                            }
                        }
                        episodeInserts.push(
                            existingMap.has(row.externalId)
                                ? {
                                      ...row,
                                      externalId: `${row.externalId}#${now.getTime()}`,
                                  }
                                : row,
                        );
                    }
                }

                if (supersededIdsToEnd.size > 0) {
                    await tx
                        .update(reports)
                        .set({
                            status: 'ended',
                            endsAt: sql`now()`,
                            updatedAt: sql`now()`,
                        })
                        .where(inArray(reports.id, [...supersededIdsToEnd]));
                }

                const rowsToInsert = [...episodeInserts, ...toInsert];
                let insertedRows: ReportItem[] = [];
                if (rowsToInsert.length > 0) {
                    insertedRows = await tx
                        .insert(reports)
                        .values(rowsToInsert)
                        .onConflictDoNothing({
                            target: [reports.source, reports.externalId],
                        })
                        .returning();
                }

                for (const row of toTransition) {
                    await tx
                        .update(reports)
                        .set({
                            observedAt: row.observedAt,
                            endsAt: sql`coalesce(${row.endsAt ?? null}, ${reports.endsAt})`,
                            status:
                                row.status === 'ended'
                                    ? 'ended'
                                    : sql`${reports.status}`,
                            updatedAt:
                                row.status === 'ended'
                                    ? sql`now()`
                                    : sql`${reports.updatedAt}`,
                        })
                        .where(
                            and(
                                eq(reports.source, strategy.source),
                                eq(reports.externalId, row.externalId),
                            ),
                        );
                }

                const heartbeatIds = toHeartbeat.map((r) => r.externalId);
                if (heartbeatIds.length > 0) {
                    await tx
                        .update(reports)
                        .set({ observedAt: new Date() })
                        .where(
                            and(
                                eq(reports.source, strategy.source),
                                inArray(reports.externalId, heartbeatIds),
                            ),
                        );
                }

                if (heartbeatRowIds.size > 0) {
                    await tx
                        .update(reports)
                        .set({ observedAt: now })
                        .where(inArray(reports.id, [...heartbeatRowIds]));
                }

                return {
                    inserted: insertedRows.filter(
                        (row) =>
                            !(
                                row.locationLabel &&
                                alreadyOngoingLocations.has(row.locationLabel)
                            ),
                    ),
                    updated:
                        toTransition.length +
                        toHeartbeat.length +
                        heartbeatRowIds.size,
                    skipped: skipped.length,
                };
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
                    endsAt: events.endsAt,
                })
                .from(events)
                .where(
                    and(
                        eq(events.source, strategy.source),
                        inArray(events.externalId, externalIds),
                    ),
                );

            const existingMap = new Map<string, ExistingRowState>(
                existing.map((e) => [
                    e.externalId,
                    { status: e.status, endsAt: e.endsAt },
                ]),
            );
            const now = new Date();
            const supersededIdsToEnd = new Set<number>();
            const episodeInserts: EventInsert[] = [];
            const heartbeatRowIds = new Set<number>();

            const stateFeed = strategy.stateFeed === true;
            const episodeRows = stateFeed
                ? eventRows.filter((r) => !r.endsAt && r.status !== 'ended')
                : [];
            const episodeSet = new Set(episodeRows);
            const remainder = eventRows.filter((r) => !episodeSet.has(r));
            const { toInsert, skipped, toTransition, toHeartbeat } =
                partitionRows(remainder, existingMap);

            if (episodeRows.length > 0) {
                const incomingCategories = Array.from(
                    new Set(episodeRows.map((r) => r.category)),
                );
                const activeRows = await tx
                    .select({
                        id: events.id,
                        externalId: events.externalId,
                        category: events.category,
                        status: events.status,
                    })
                    .from(events)
                    .where(
                        and(
                            eq(events.source, strategy.source),
                            inArray(events.category, incomingCategories),
                            inArray(events.status, ['ongoing', 'omitted']),
                            isNull(events.endsAt),
                        ),
                    );

                const activeByCategory = new Map<string, typeof activeRows>();
                for (const active of activeRows) {
                    const bucket = activeByCategory.get(active.category);
                    if (bucket) {
                        bucket.push(active);
                    } else {
                        activeByCategory.set(active.category, [active]);
                    }
                }

                for (const row of episodeRows) {
                    const actives = activeByCategory.get(row.category) ?? [];
                    const match = actives.find(
                        (active) =>
                            stripEpisodeSuffix(active.externalId) ===
                            row.externalId,
                    );
                    if (match) {
                        heartbeatRowIds.add(match.id);
                        continue;
                    }
                    for (const active of actives) {
                        supersededIdsToEnd.add(active.id);
                    }
                    episodeInserts.push(
                        existingMap.has(row.externalId)
                            ? {
                                  ...row,
                                  externalId: `${row.externalId}#${now.getTime()}`,
                              }
                            : row,
                    );
                }
            }

            if (supersededIdsToEnd.size > 0) {
                await tx
                    .update(events)
                    .set({
                        status: 'ended',
                        endsAt: sql`now()`,
                        updatedAt: sql`now()`,
                    })
                    .where(inArray(events.id, [...supersededIdsToEnd]));
            }

            const rowsToInsert = [...episodeInserts, ...toInsert];
            let insertedRows: EventItem[] = [];
            if (rowsToInsert.length > 0) {
                insertedRows = await tx
                    .insert(events)
                    .values(rowsToInsert)
                    .onConflictDoNothing({
                        target: [events.source, events.externalId],
                    })
                    .returning();
            }

            for (const row of toTransition) {
                await tx
                    .update(events)
                    .set({
                        observedAt: row.observedAt,
                        endsAt: sql`coalesce(${row.endsAt ?? null}, ${events.endsAt})`,
                        status:
                            row.status === 'ended'
                                ? 'ended'
                                : sql`${events.status}`,
                        updatedAt:
                            row.status === 'ended'
                                ? sql`now()`
                                : sql`${events.updatedAt}`,
                    })
                    .where(
                        and(
                            eq(events.source, strategy.source),
                            eq(events.externalId, row.externalId),
                        ),
                    );
            }

            const heartbeatIds = toHeartbeat.map((r) => r.externalId);
            if (heartbeatIds.length > 0) {
                await tx
                    .update(events)
                    .set({ observedAt: new Date() })
                    .where(
                        and(
                            eq(events.source, strategy.source),
                            inArray(events.externalId, heartbeatIds),
                        ),
                    );
            }

            if (heartbeatRowIds.size > 0) {
                await tx
                    .update(events)
                    .set({ observedAt: now })
                    .where(inArray(events.id, [...heartbeatRowIds]));
            }

            return {
                inserted: insertedRows,
                updated:
                    toTransition.length +
                    toHeartbeat.length +
                    heartbeatRowIds.size,
                skipped: skipped.length,
            };
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
