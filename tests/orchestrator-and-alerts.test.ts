import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Cron } from 'croner';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
    type EventItem,
    type ReportItem,
    reports,
} from '../src/core/schema.js';
import type { AlertDispatcher } from '../src/infrastructure/alerting/dispatcher.js';
import type { DbOrTx } from '../src/infrastructure/database/db.js';
import { ScrapingOrchestrator } from '../src/modules/scraping/orchestrator.js';
import type { ScrapingStrategy } from '../src/modules/scraping/strategy.interface.js';
import { at } from './test-utils.js';

type ExistingReport = {
    id: number;
    externalId: string;
    locationLabel: string | null;
    status: 'ongoing' | 'omitted' | 'scheduled' | 'ended' | 'unknown';
};

function createReportDb(params: {
    incomingExisting?: Array<{ externalId: string }>;
    supersededRows?: ExistingReport[];
    returnedRows?: Array<Record<string, unknown>>;
}) {
    const state = {
        selected: 0,
        insertedRows: [] as Array<Record<string, unknown>>,
        endedIds: [] as number[],
    };

    const tx = {
        select: () => ({
            from: () => ({
                where: async () =>
                    state.selected++ === 0
                        ? (params.incomingExisting ?? [])
                        : (params.supersededRows ?? []),
            }),
        }),
        update: () => ({
            set: () => ({
                where: async () => {
                    state.endedIds.push(
                        ...(params.supersededRows ?? []).map((row) => row.id),
                    );
                },
            }),
        }),
        insert: () => ({
            values: (rows: Array<Record<string, unknown>>) => {
                state.insertedRows = rows;
                return {
                    onConflictDoUpdate: () => ({
                        returning: async () =>
                            params.returnedRows ??
                            rows.map((row, index) => ({
                                id: index + 100,
                                ...row,
                            })),
                    }),
                };
            },
        }),
    };

    const db = {
        transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx),
    } as unknown as DbOrTx;

    return { db, state };
}

function createEventDb(existing: Array<{ externalId: string }> = []) {
    const state = {
        updateCount: 0,
        insertedRows: [] as Array<Record<string, unknown>>,
    };
    const tx = {
        select: () => ({
            from: () => ({ where: async () => existing }),
        }),
        update: () => ({
            set: () => ({
                where: async () => {
                    state.updateCount += 1;
                },
            }),
        }),
        insert: () => ({
            values: (rows: Array<Record<string, unknown>>) => {
                state.insertedRows = rows;
                return {
                    onConflictDoUpdate: () => ({
                        returning: async () =>
                            rows.map((row, index) => ({
                                id: index + 1,
                                ...row,
                            })),
                    }),
                };
            },
        }),
    };
    return {
        db: {
            transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx),
        } as unknown as DbOrTx,
        state,
    };
}

function createDispatcher() {
    const batches: Array<{
        source: string;
        items: Array<ReportItem | EventItem>;
    }> = [];
    const dispatcher = {
        dispatch: async (
            source: string,
            items: Array<ReportItem | EventItem>,
        ) => {
            batches.push({ source, items });
        },
    } as unknown as AlertDispatcher;
    return { dispatcher, batches };
}

function reportStrategy(stateFeed: boolean | undefined, externalId = 'new') {
    return {
        ...(stateFeed === undefined ? {} : { stateFeed }),
        source: 'test-source',
        url: 'http://test',
        category: 'water',
        target: 'reports',
        schedule: '*/30 * * * *',
        fetch: async () => [],
        parse: async () => [
            {
                externalId,
                source: 'test-source',
                category: 'water',
                title: 'Test report',
                description: null,
                municipalityCode: null,
                locationLabel: 'Same location',
                status: 'ongoing',
                observedAt: new Date(),
                startsAt: new Date(),
                endsAt: null,
            },
        ],
    } satisfies ScrapingStrategy;
}

function eventStrategy(stateFeed = true, externalId = 'new') {
    return {
        stateFeed,
        source: 'test-events',
        url: 'http://test',
        category: 'fuel_price',
        target: 'events',
        schedule: '0 */2 * * *',
        fetch: async () => [],
        parse: async () => [
            {
                externalId,
                source: 'test-events',
                category: 'fuel_price',
                title: 'Test event',
                description: null,
                status: 'ongoing',
                observedAt: new Date(),
                startsAt: new Date(),
                endsAt: null,
            },
        ],
    } satisfies ScrapingStrategy;
}

describe('ScrapingOrchestrator insertion and alert policy', () => {
    it('keeps distinct incidents at the same label and alerts the new report', async () => {
        const { db, state } = createReportDb({
            incomingExisting: [],
            supersededRows: [
                {
                    id: 1001,
                    externalId: 'old-incident',
                    locationLabel: 'Same location',
                    status: 'ongoing',
                },
            ],
        });
        const { dispatcher, batches } = createDispatcher();
        const strategy = reportStrategy(undefined);

        await new ScrapingOrchestrator(db, [strategy], dispatcher).run(
            strategy,
        );

        assert.deepEqual(state.endedIds, []);
        assert.equal(
            state.selected,
            1,
            'incident strategy must not query superseded rows',
        );
        assert.equal(batches.length, 1);
        assert.equal(at(at(batches, 0).items, 0).externalId, 'new');
    });

    it('ends the previous ongoing state window and suppresses duplicate alert', async () => {
        const prior = {
            id: 1,
            externalId: 'old-window',
            locationLabel: 'Same location',
            status: 'ongoing' as const,
        };
        const { db, state } = createReportDb({ supersededRows: [prior] });
        const { dispatcher, batches } = createDispatcher();
        const strategy = reportStrategy(true);

        await new ScrapingOrchestrator(db, [strategy], dispatcher).run(
            strategy,
        );

        assert.deepEqual(state.endedIds, [1]);
        assert.equal(batches.length, 0);
    });

    it('does not suppress an ongoing alert when the previous state was omitted', async () => {
        const { db, state } = createReportDb({
            supersededRows: [
                {
                    id: 2,
                    externalId: 'previously-good',
                    locationLabel: 'Same location',
                    status: 'omitted',
                },
            ],
        });
        const { dispatcher, batches } = createDispatcher();
        const strategy = reportStrategy(true);

        await new ScrapingOrchestrator(db, [strategy], dispatcher).run(
            strategy,
        );

        assert.deepEqual(state.endedIds, [2]);
        assert.equal(batches.length, 1);
    });

    it('does not supersede when incoming externalId already exists', async () => {
        const { db, state } = createReportDb({
            incomingExisting: [{ externalId: 'new' }],
            supersededRows: [],
        });
        const { dispatcher, batches } = createDispatcher();
        const strategy = reportStrategy(true);

        await new ScrapingOrchestrator(db, [strategy], dispatcher).run(
            strategy,
        );

        assert.equal(state.selected, 1);
        assert.deepEqual(state.endedIds, []);
        assert.equal(batches.length, 0);
    });

    it('deduplicates repeated report externalIds before insertion', async () => {
        const { db, state } = createReportDb({});
        const { dispatcher } = createDispatcher();
        const base = reportStrategy(undefined);
        const strategy: ScrapingStrategy = {
            ...base,
            parse: async () => [
                ...(await base.parse()),
                ...(await base.parse()),
            ],
        };

        await new ScrapingOrchestrator(db, [strategy], dispatcher).run(
            strategy,
        );
        assert.equal(state.insertedRows.length, 1);
    });

    it('does not dispatch newly inserted omitted or scheduled reports', async () => {
        const { db } = createReportDb({});
        const { dispatcher, batches } = createDispatcher();
        const base = reportStrategy(undefined);
        const strategy: ScrapingStrategy = {
            ...base,
            parse: async () =>
                (await base.parse()).map((row, index) => ({
                    ...row,
                    externalId: `status-${index}`,
                    status: index === 0 ? 'omitted' : 'scheduled',
                })),
        };

        await new ScrapingOrchestrator(db, [strategy], dispatcher).run(
            strategy,
        );
        assert.equal(batches.length, 0);
    });

    it('skips report superseding when new rows are ended or have no location label', async () => {
        const { db, state } = createReportDb({});
        const { dispatcher } = createDispatcher();
        const base = reportStrategy(true);
        const sourceRow = at(await base.parse(), 0);
        const strategy: ScrapingStrategy = {
            ...base,
            parse: async () => [
                { ...sourceRow, externalId: 'dated', endsAt: new Date() },
                { ...sourceRow, externalId: 'unlocated', locationLabel: null },
            ],
        };

        await new ScrapingOrchestrator(db, [strategy], dispatcher).run(
            strategy,
        );
        assert.equal(state.selected, 1);
        assert.deepEqual(state.endedIds, []);
    });

    it('supersedes and alerts new open-ended state events, but not known events', async () => {
        const { db, state } = createEventDb();
        const { dispatcher, batches } = createDispatcher();
        const strategy = eventStrategy();
        await new ScrapingOrchestrator(db, [strategy], dispatcher).run(
            strategy,
        );
        assert.equal(state.updateCount, 1);
        assert.equal(batches.length, 1);

        const known = createEventDb([{ externalId: 'new' }]);
        const knownDispatcher = createDispatcher();
        await new ScrapingOrchestrator(
            known.db,
            [strategy],
            knownDispatcher.dispatcher,
        ).run(strategy);
        assert.equal(known.state.updateCount, 0);
        assert.equal(knownDispatcher.batches.length, 0);
    });

    it('deduplicates repeated event externalIds before insertion', async () => {
        const { db, state } = createEventDb();
        const { dispatcher } = createDispatcher();
        const base = eventStrategy();
        const strategy: ScrapingStrategy = {
            ...base,
            parse: async () => [
                ...(await base.parse()),
                ...(await base.parse()),
            ],
        };

        await new ScrapingOrchestrator(db, [strategy], dispatcher).run(
            strategy,
        );
        assert.equal(state.insertedRows.length, 1);
    });

    it('does not dispatch when parsing yields no rows and catches strategy failures', async () => {
        const { db } = createReportDb({});
        const { dispatcher, batches } = createDispatcher();
        const empty: ScrapingStrategy = {
            ...reportStrategy(undefined),
            parse: async () => [],
        };
        const failing: ScrapingStrategy = {
            ...empty,
            fetch: async () => {
                throw new Error('upstream unavailable');
            },
        };
        const parseFailure: ScrapingStrategy = {
            ...empty,
            parse: async () => {
                throw new Error('invalid upstream payload');
            },
        };
        const orchestrator = new ScrapingOrchestrator(
            db,
            [empty, failing],
            dispatcher,
        );
        await orchestrator.run(empty);
        await orchestrator.run(failing);
        await orchestrator.run(parseFailure);
        assert.equal(batches.length, 0);
    });
});

describe('ScrapingOrchestrator lifecycle reconciliation', () => {
    it('starts and stops cron jobs for strategies and the reconciler', () => {
        let fetched = 0;
        const strategy: ScrapingStrategy = {
            ...reportStrategy(undefined),
            fetch: async () => {
                fetched++;
                return [];
            },
            parse: async () => [],
        };
        const orchestrator = new ScrapingOrchestrator(
            {} as DbOrTx,
            [strategy],
            createDispatcher().dispatcher,
        );
        orchestrator.start();
        const jobs = (orchestrator as unknown as { jobs: Cron[] }).jobs;
        assert.equal(jobs.length, 2);
        orchestrator.stop();
        assert.equal(jobs.length, 0);
        assert.ok(jobs.every((job) => job.isStopped()));
        assert.equal(fetched, 1);
    });

    it('dispatches reconciled starts grouped by source and catches transaction errors', async () => {
        const startedRows = [
            { id: 1, source: 'source-a', status: 'ongoing' },
            { id: 2, source: 'source-a', status: 'ongoing' },
            { id: 3, source: 'source-b', status: 'ongoing' },
        ];
        const results = [
            [{ id: 5, source: 'source-ended' }],
            startedRows,
            [{ id: 4, source: 'source-unknown' }],
            [],
            [],
            [],
        ];
        let call = 0;
        const tx = {
            update: () => ({
                set: () => ({
                    where: () => ({
                        returning: async () => at(results, call++),
                    }),
                }),
            }),
        };
        const { dispatcher, batches } = createDispatcher();
        const orchestrator = new ScrapingOrchestrator(
            {
                transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
                    fn(tx),
            } as unknown as DbOrTx,
            [],
            dispatcher,
        );
        orchestrator.start();
        const jobs = (orchestrator as unknown as { jobs: Cron[] }).jobs;
        await at(jobs, 0).trigger();
        orchestrator.stop();
        assert.deepEqual(
            batches.map(({ source, items }) => [source, items.length]),
            [
                ['source-a', 2],
                ['source-b', 1],
            ],
        );

        const errorOrchestrator = new ScrapingOrchestrator(
            {
                transaction: async () => {
                    throw new Error('database unavailable');
                },
            } as unknown as DbOrTx,
            [],
            createDispatcher().dispatcher,
        );
        errorOrchestrator.start();
        const errorJobs = (errorOrchestrator as unknown as { jobs: Cron[] })
            .jobs;
        await at(errorJobs, 0).trigger();
        errorOrchestrator.stop();
    });

    it('runs ended, started, then unknown updates and returns each transition set', async () => {
        const returned = [
            [{ id: 1, source: 'a', status: 'ended' }],
            [{ id: 2, source: 'b', status: 'ongoing' }],
            [{ id: 3, source: 'c', status: 'unknown' }],
        ];
        const sets: unknown[] = [];
        const conditions: unknown[] = [];
        let call = 0;
        const tx = {
            update: () => ({
                set: (value: unknown) => {
                    sets.push(value);
                    return {
                        where: (condition: unknown) => {
                            conditions.push(condition);
                            return {
                                returning: async () => at(returned, call++),
                            };
                        },
                    };
                },
            }),
        };
        const orchestrator = new ScrapingOrchestrator(
            {} as DbOrTx,
            [],
            createDispatcher().dispatcher,
        );
        const reconcile = (
            orchestrator as unknown as {
                reconcileTable: (
                    tx: unknown,
                    table: unknown,
                ) => Promise<unknown>;
            }
        ).reconcileTable.bind(orchestrator);

        const result = (await reconcile(tx, reports)) as {
            ended: Array<{ id: number }>;
            started: Array<{ id: number }>;
            unknown: Array<{ id: number }>;
        };
        assert.deepEqual(
            result.ended.map((item) => item.id),
            [1],
        );
        assert.deepEqual(
            result.started.map((item) => item.id),
            [2],
        );
        assert.deepEqual(
            result.unknown.map((item) => item.id),
            [3],
        );
        assert.equal(sets.length, 3);
        const sql = conditions.map(
            (condition) => new PgDialect().sqlToQuery(condition as never).sql,
        );
        assert.match(at(sql, 0), /"reports"\."ends_at" <=/);
        assert.match(at(sql, 0), /"reports"\."status" in/);
        assert.match(at(sql, 1), /"reports"\."starts_at" <=/);
        assert.match(at(sql, 1), /"reports"\."status" =/);
        assert.match(at(sql, 2), /"reports"\."observed_at" <=/);
        assert.match(at(sql, 2), /"reports"\."status" in/);
    });
});
