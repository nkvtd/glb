import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Cron } from 'croner';
import type { SQL } from 'drizzle-orm';
import PQueue from 'p-queue';
import { reports } from '../src/core/schema.js';
import type { DbOrTx } from '../src/infrastructure/database/db.js';
import { ScrapingOrchestrator } from '../src/modules/scraping/orchestrator.js';
import type { ScrapingStrategy } from '../src/modules/scraping/strategy.interface.js';
import { at, sqlText } from './util/assertions.js';
import {
    createDispatcher,
    createEventDb,
    createReportDb,
} from './util/fakes.js';

function reportStrategy(
    stateFeed: boolean | undefined,
    externalId = 'new',
    status: 'ongoing' | 'omitted' | 'ended' = 'ongoing',
) {
    return {
        ...(stateFeed === undefined ? {} : { stateFeed }),
        source: 'test-source',
        url: 'http://test',
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
                status,
                observedAt: new Date(),
                startsAt: new Date(),
                endsAt: null,
            },
        ],
    } satisfies ScrapingStrategy;
}

function eventStrategy(
    stateFeed = true,
    externalId = 'new',
    status: 'ongoing' | 'omitted' | 'ended' = 'ongoing',
) {
    return {
        stateFeed,
        source: 'test-events',
        url: 'http://test',
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
                status,
                observedAt: new Date(),
                startsAt: new Date(),
                endsAt: null,
            },
        ],
    } satisfies ScrapingStrategy;
}

describe('ScrapingOrchestrator insertion and alert policy', () => {
    it('keeps distinct incidents at the same label and alerts the new report', async () => {
        const { db, state } = createReportDb({});
        const { dispatcher, batches } = createDispatcher();
        const strategy = reportStrategy(undefined);

        await new ScrapingOrchestrator(
            db,
            [strategy],
            dispatcher,
            new PQueue({ concurrency: 4 }),
        ).run(strategy);

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
        const { db, state } = createReportDb({ activeRows: [prior] });
        const { dispatcher, batches } = createDispatcher();
        const strategy = reportStrategy(true);

        await new ScrapingOrchestrator(
            db,
            [strategy],
            dispatcher,
            new PQueue({ concurrency: 4 }),
        ).run(strategy);

        assert.deepEqual(state.endedIds, [1]);
        assert.equal(batches.length, 0);
    });

    it('does not suppress an ongoing alert when the previous state was omitted', async () => {
        const { db, state } = createReportDb({
            activeRows: [
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

        await new ScrapingOrchestrator(
            db,
            [strategy],
            dispatcher,
            new PQueue({ concurrency: 4 }),
        ).run(strategy);

        assert.deepEqual(state.endedIds, [2]);
        assert.equal(batches.length, 1);
    });

    it('does not supersede when incoming externalId already exists', async () => {
        const { db, state } = createReportDb({
            incomingExisting: [{ externalId: 'new' }],
            activeRows: [
                {
                    id: 7,
                    externalId: 'new',
                    locationLabel: 'Same location',
                    status: 'ongoing',
                },
            ],
        });
        const { dispatcher, batches } = createDispatcher();
        const strategy = reportStrategy(true);

        await new ScrapingOrchestrator(
            db,
            [strategy],
            dispatcher,
            new PQueue({ concurrency: 4 }),
        ).run(strategy);

        assert.equal(state.selected, 2);
        assert.deepEqual(state.insertedRows, []);
        assert.deepEqual(state.endedIds, []);
        assert.equal(state.updatedCount, 1, 'the same episode is heartbeated');
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

        await new ScrapingOrchestrator(
            db,
            [strategy],
            dispatcher,
            new PQueue({ concurrency: 4 }),
        ).run(strategy);
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

        await new ScrapingOrchestrator(
            db,
            [strategy],
            dispatcher,
            new PQueue({ concurrency: 4 }),
        ).run(strategy);
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

        await new ScrapingOrchestrator(
            db,
            [strategy],
            dispatcher,
            new PQueue({ concurrency: 4 }),
        ).run(strategy);
        assert.equal(state.selected, 1);
        assert.deepEqual(state.endedIds, []);
    });

    it('ends the active state event on a new open-ended reading, but heartbeats a known one', async () => {
        const { db, state } = createEventDb({
            activeRows: [{ id: 4, externalId: 'old-state', status: 'ongoing' }],
        });
        const { dispatcher, batches } = createDispatcher();
        const strategy = eventStrategy();
        await new ScrapingOrchestrator(
            db,
            [strategy],
            dispatcher,
            new PQueue({ concurrency: 4 }),
        ).run(strategy);
        assert.deepEqual(state.endedIds, [4]);
        assert.equal(state.insertedRows.length, 1);
        assert.equal(batches.length, 1);

        const known = createEventDb({
            incomingExisting: [{ externalId: 'new' }],
            activeRows: [{ id: 5, externalId: 'new', status: 'ongoing' }],
        });
        const knownDispatcher = createDispatcher();
        await new ScrapingOrchestrator(
            known.db,
            [strategy],
            knownDispatcher.dispatcher,
            new PQueue({ concurrency: 4 }),
        ).run(strategy);
        assert.deepEqual(known.state.endedIds, []);
        assert.deepEqual(known.state.insertedRows, []);
        assert.equal(
            known.state.updatedCount,
            1,
            'a known active event only gets a heartbeat update',
        );
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

        await new ScrapingOrchestrator(
            db,
            [strategy],
            dispatcher,
            new PQueue({ concurrency: 4 }),
        ).run(strategy);
        assert.equal(state.insertedRows.length, 1);
    });

    it('does not treat a re-scraped ended row as newly inserted for non-stateFeed strategies', async () => {
        const { db, state } = createReportDb({
            incomingExisting: [
                {
                    externalId: 'known-ended',
                    status: 'ended',
                    endsAt: new Date('2026-10-20T00:00:00.000Z'),
                },
            ],
        });
        const { dispatcher, batches } = createDispatcher();
        const base = reportStrategy(undefined);
        const sourceRow = at(await base.parse(), 0);
        const strategy: ScrapingStrategy = {
            ...base,
            parse: async () => [
                {
                    ...sourceRow,
                    externalId: 'known-ended',
                    status: 'ended',
                    endsAt: new Date(),
                },
            ],
        };
        const orchestrator = new ScrapingOrchestrator(
            db,
            [strategy],
            dispatcher,
            new PQueue({ concurrency: 4 }),
        );
        const insert = (
            orchestrator as unknown as {
                insert: (
                    strategy: ScrapingStrategy,
                    rows: Array<Record<string, unknown>>,
                ) => Promise<{
                    inserted: Array<Record<string, unknown>>;
                    updated: number;
                    skipped: number;
                }>;
            }
        ).insert.bind(orchestrator);
        const result = await insert(
            strategy,
            await strategy.parse(await strategy.fetch()),
        );
        assert.deepEqual(
            result.inserted,
            [],
            'a re-scraped ended row is not newly inserted',
        );
        assert.deepEqual(state.insertedRows, [], 'no insert must be issued');
        assert.equal(state.updatedCount, 0, 'no update must be issued');
        assert.deepEqual(state.endedIds, []);
        await orchestrator.run(strategy);
        assert.equal(batches.length, 0);
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
            new PQueue({ concurrency: 4 }),
        );
        await orchestrator.run(empty);
        await orchestrator.run(failing);
        await orchestrator.run(parseFailure);
        assert.equal(batches.length, 0);
    });
});

describe('ScrapingOrchestrator stateFeed per-episode timeline', () => {
    const label = 'Same location';

    it('reports: normal -> outage -> normal -> outage writes one immutable episode per transition', async () => {
        // Phase 1: a new outage reading ends the active normal episode and alerts.
        const outageDb = createReportDb({
            activeRows: [
                {
                    id: 5,
                    externalId: 'loc-2026-11-22-normal',
                    locationLabel: label,
                    status: 'omitted',
                },
            ],
        });
        const outageDispatcher = createDispatcher();
        const outageStrategy = reportStrategy(true, 'loc-2026-11-22-outage');
        await new ScrapingOrchestrator(
            outageDb.db,
            [outageStrategy],
            outageDispatcher.dispatcher,
            new PQueue({ concurrency: 4 }),
        ).run(outageStrategy);
        assert.deepEqual(outageDb.state.endedIds, [5]);
        assert.equal(
            at(outageDb.state.insertedRows, 0).externalId,
            'loc-2026-11-22-outage',
        );
        assert.equal(outageDispatcher.batches.length, 1);
        assert.equal(
            at(at(outageDispatcher.batches, 0).items, 0).status,
            'ongoing',
        );

        // Phase 2: recovery inserts a new suffixed normal episode, ends the
        // active outage, and never alerts.
        const recoveryDb = createReportDb({
            incomingExisting: [
                { externalId: 'loc-2026-11-22-normal', status: 'ended' },
            ],
            activeRows: [
                {
                    id: 9,
                    externalId: 'loc-2026-11-22-outage',
                    locationLabel: label,
                    status: 'ongoing',
                },
            ],
        });
        const recoveryDispatcher = createDispatcher();
        const recoveryStrategy = reportStrategy(
            true,
            'loc-2026-11-22-normal',
            'omitted',
        );
        await new ScrapingOrchestrator(
            recoveryDb.db,
            [recoveryStrategy],
            recoveryDispatcher.dispatcher,
            new PQueue({ concurrency: 4 }),
        ).run(recoveryStrategy);
        assert.deepEqual(
            recoveryDb.state.endedIds,
            [9],
            'recovery must end the active outage episode',
        );
        assert.match(
            String(at(recoveryDb.state.insertedRows, 0).externalId),
            /^loc-2026-11-22-normal#\d+$/,
            'the new normal episode is suffixed because the base ID exists',
        );
        assert.equal(
            recoveryDispatcher.batches.length,
            0,
            'recovery must not dispatch a false alert',
        );

        // Phase 3: the next normal poll matches the active episode by base ID
        // and only heartbeats it.
        const steadyDb = createReportDb({
            incomingExisting: [
                { externalId: 'loc-2026-11-22-normal', status: 'ended' },
            ],
            activeRows: [
                {
                    id: 11,
                    externalId: 'loc-2026-11-22-normal#1700000000000',
                    locationLabel: label,
                    status: 'omitted',
                },
            ],
        });
        const steadyDispatcher = createDispatcher();
        const steadyStrategy = reportStrategy(
            true,
            'loc-2026-11-22-normal',
            'omitted',
        );
        await new ScrapingOrchestrator(
            steadyDb.db,
            [steadyStrategy],
            steadyDispatcher.dispatcher,
            new PQueue({ concurrency: 4 }),
        ).run(steadyStrategy);
        assert.deepEqual(steadyDb.state.insertedRows, []);
        assert.deepEqual(steadyDb.state.endedIds, []);
        assert.equal(steadyDb.state.updatedCount, 1, 'heartbeat by id');
        assert.equal(steadyDispatcher.batches.length, 0);

        // Phase 4: a second outage ends the omitted normal episode and
        // dispatches a fresh alert.
        const secondDb = createReportDb({
            incomingExisting: [
                { externalId: 'loc-2026-11-22-normal', status: 'ended' },
                { externalId: 'loc-2026-11-22-outage', status: 'ended' },
            ],
            activeRows: [
                {
                    id: 11,
                    externalId: 'loc-2026-11-22-normal#1700000000000',
                    locationLabel: label,
                    status: 'omitted',
                },
            ],
        });
        const secondDispatcher = createDispatcher();
        const secondStrategy = reportStrategy(true, 'loc-2026-11-22-outage');
        await new ScrapingOrchestrator(
            secondDb.db,
            [secondStrategy],
            secondDispatcher.dispatcher,
            new PQueue({ concurrency: 4 }),
        ).run(secondStrategy);
        assert.deepEqual(secondDb.state.endedIds, [11]);
        assert.match(
            String(at(secondDb.state.insertedRows, 0).externalId),
            /^loc-2026-11-22-outage#\d+$/,
        );
        assert.equal(
            secondDispatcher.batches.length,
            1,
            'an omitted predecessor must not suppress the alert',
        );
        assert.equal(
            at(at(secondDispatcher.batches, 0).items, 0).status,
            'ongoing',
        );
    });

    it('events: normal -> outage -> normal -> outage writes one immutable episode per transition', async () => {
        // Phase 1: a new outage event ends the active normal episode and alerts.
        const outageDb = createEventDb({
            activeRows: [
                {
                    id: 5,
                    externalId: 'loc-2026-11-22-normal',
                    status: 'omitted',
                },
            ],
        });
        const outageDispatcher = createDispatcher();
        const outageStrategy = eventStrategy(true, 'loc-2026-11-22-outage');
        await new ScrapingOrchestrator(
            outageDb.db,
            [outageStrategy],
            outageDispatcher.dispatcher,
            new PQueue({ concurrency: 4 }),
        ).run(outageStrategy);
        assert.deepEqual(outageDb.state.endedIds, [5]);
        assert.equal(
            at(outageDb.state.insertedRows, 0).externalId,
            'loc-2026-11-22-outage',
        );
        assert.equal(outageDispatcher.batches.length, 1);

        // Phase 2: recovery inserts a suffixed normal episode, ends the outage,
        // and never alerts.
        const recoveryDb = createEventDb({
            incomingExisting: [
                { externalId: 'loc-2026-11-22-normal', status: 'ended' },
            ],
            activeRows: [
                {
                    id: 9,
                    externalId: 'loc-2026-11-22-outage',
                    status: 'ongoing',
                },
            ],
        });
        const recoveryDispatcher = createDispatcher();
        const recoveryStrategy = eventStrategy(
            true,
            'loc-2026-11-22-normal',
            'omitted',
        );
        await new ScrapingOrchestrator(
            recoveryDb.db,
            [recoveryStrategy],
            recoveryDispatcher.dispatcher,
            new PQueue({ concurrency: 4 }),
        ).run(recoveryStrategy);
        assert.deepEqual(recoveryDb.state.endedIds, [9]);
        assert.match(
            String(at(recoveryDb.state.insertedRows, 0).externalId),
            /^loc-2026-11-22-normal#\d+$/,
        );
        assert.equal(recoveryDispatcher.batches.length, 0);

        // Phase 3: the next normal poll only heartbeats the active episode.
        const steadyDb = createEventDb({
            incomingExisting: [
                { externalId: 'loc-2026-11-22-normal', status: 'ended' },
            ],
            activeRows: [
                {
                    id: 11,
                    externalId: 'loc-2026-11-22-normal#1700000000000',
                    status: 'omitted',
                },
            ],
        });
        const steadyDispatcher = createDispatcher();
        const steadyStrategy = eventStrategy(
            true,
            'loc-2026-11-22-normal',
            'omitted',
        );
        await new ScrapingOrchestrator(
            steadyDb.db,
            [steadyStrategy],
            steadyDispatcher.dispatcher,
            new PQueue({ concurrency: 4 }),
        ).run(steadyStrategy);
        assert.deepEqual(steadyDb.state.insertedRows, []);
        assert.deepEqual(steadyDb.state.endedIds, []);
        assert.equal(steadyDb.state.updatedCount, 1, 'heartbeat by id');
        assert.equal(steadyDispatcher.batches.length, 0);

        // Phase 4: a second outage ends the omitted normal episode and alerts.
        const secondDb = createEventDb({
            incomingExisting: [
                { externalId: 'loc-2026-11-22-normal', status: 'ended' },
                { externalId: 'loc-2026-11-22-outage', status: 'ended' },
            ],
            activeRows: [
                {
                    id: 11,
                    externalId: 'loc-2026-11-22-normal#1700000000000',
                    status: 'omitted',
                },
            ],
        });
        const secondDispatcher = createDispatcher();
        const secondStrategy = eventStrategy(true, 'loc-2026-11-22-outage');
        await new ScrapingOrchestrator(
            secondDb.db,
            [secondStrategy],
            secondDispatcher.dispatcher,
            new PQueue({ concurrency: 4 }),
        ).run(secondStrategy);
        assert.deepEqual(secondDb.state.endedIds, [11]);
        assert.match(
            String(at(secondDb.state.insertedRows, 0).externalId),
            /^loc-2026-11-22-outage#\d+$/,
        );
        assert.equal(secondDispatcher.batches.length, 1);
        assert.equal(
            at(at(secondDispatcher.batches, 0).items, 0).status,
            'ongoing',
        );
    });

    it('suppresses the duplicate alert when superseding an ongoing episode', async () => {
        const { db, state } = createReportDb({
            activeRows: [
                {
                    id: 21,
                    externalId: 'st-1-h1',
                    locationLabel: label,
                    status: 'ongoing',
                },
            ],
        });
        const { dispatcher, batches } = createDispatcher();
        const strategy = reportStrategy(true, 'st-1-h2');

        await new ScrapingOrchestrator(
            db,
            [strategy],
            dispatcher,
            new PQueue({ concurrency: 4 }),
        ).run(strategy);

        assert.deepEqual(state.endedIds, [21]);
        assert.equal(at(state.insertedRows, 0).externalId, 'st-1-h2');
        assert.equal(batches.length, 0);
    });

    it('non-stateFeed: never re-opens or re-inserts an ended row', async () => {
        const { db, state } = createReportDb({
            incomingExisting: [
                {
                    externalId: 'day-normal',
                    status: 'ended',
                    endsAt: new Date('2026-10-20T00:00:00.000Z'),
                },
            ],
        });
        const { dispatcher, batches } = createDispatcher();
        const strategy = reportStrategy(undefined, 'day-normal', 'omitted');
        await new ScrapingOrchestrator(
            db,
            [strategy],
            dispatcher,
            new PQueue({ concurrency: 4 }),
        ).run(strategy);
        assert.equal(batches.length, 0);
        assert.deepEqual(state.insertedRows, []);
        assert.deepEqual(state.endedIds, []);
        assert.equal(state.updatedCount, 1, 'the ended row is heartbeated');
        assert.equal(
            state.selected,
            1,
            'non-stateFeed runs issue a single select',
        );
    });
});

describe('ScrapingOrchestrator lifecycle reconciliation', () => {
    it('starts and stops cron jobs for strategies and the reconciler', async () => {
        let fetched = 0;
        const strategy: ScrapingStrategy = {
            ...reportStrategy(undefined),
            fetch: async () => {
                fetched++;
                return [];
            },
            parse: async () => [],
        };
        const queue = new PQueue({ concurrency: 4 });
        const orchestrator = new ScrapingOrchestrator(
            {} as DbOrTx,
            [strategy],
            createDispatcher().dispatcher,
            queue,
        );
        orchestrator.start();
        await Promise.resolve();
        await queue.onIdle();
        assert.equal(fetched, 1);
        const jobs = [...(orchestrator as unknown as { jobs: Cron[] }).jobs];
        orchestrator.stop();
        assert.equal(jobs.length, 2);
        assert.ok(jobs.every((job) => job.isStopped()));
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
            new PQueue({ concurrency: 4 }),
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
            new PQueue({ concurrency: 4 }),
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
        const conditions: SQL[] = [];
        let call = 0;
        const tx = {
            update: () => ({
                set: (value: unknown) => {
                    sets.push(value);
                    return {
                        where: (condition: SQL) => {
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
            new PQueue({ concurrency: 4 }),
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
        const sql = conditions.map((condition) => sqlText(condition));
        assert.match(at(sql, 0), /"reports"\."ends_at" <=/);
        assert.match(at(sql, 0), /"reports"\."status" in/);
        assert.match(at(sql, 1), /"reports"\."starts_at" <=/);
        assert.match(at(sql, 1), /"reports"\."status" =/);
        assert.match(at(sql, 2), /"reports"\."observed_at" <=/);
        assert.match(at(sql, 2), /"reports"\."status" in/);
    });
});

async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!check()) {
        assert.ok(Date.now() < deadline, 'timed out waiting for condition');
        await new Promise((resolve) => setTimeout(resolve, 1));
    }
}

describe('ScrapingOrchestrator queue and partitioned writes', () => {
    it('heartbeats existing active rows instead of inserting them', async () => {
        const { db, state } = createReportDb({
            incomingExisting: [{ externalId: 'new' }],
        });
        const { dispatcher, batches } = createDispatcher();
        const strategy = reportStrategy(undefined);

        await new ScrapingOrchestrator(
            db,
            [strategy],
            dispatcher,
            new PQueue({ concurrency: 4 }),
        ).run(strategy);

        assert.deepEqual(state.insertedRows, []);
        assert.equal(
            state.updatedCount,
            1,
            'active rows get one bulk heartbeat',
        );
        assert.equal(batches.length, 0);
    });

    it('inserts brand-new rows with onConflictDoNothing', async () => {
        const { db, state } = createReportDb({});
        const { dispatcher, batches } = createDispatcher();
        const strategy = reportStrategy(undefined);

        await new ScrapingOrchestrator(
            db,
            [strategy],
            dispatcher,
            new PQueue({ concurrency: 4 }),
        ).run(strategy);

        assert.equal(state.insertedRows.length, 1);
        assert.equal(state.updatedCount, 0);
        assert.equal(batches.length, 1);
    });

    it('caps concurrent strategy runs at the queue concurrency', async () => {
        let active = 0;
        let maxActive = 0;
        const releases: Array<() => void> = [];
        const strategy = (source: string): ScrapingStrategy => ({
            ...reportStrategy(undefined),
            source,
            parse: async () => [],
            fetch: () =>
                new Promise<void>((resolve) => {
                    active += 1;
                    maxActive = Math.max(maxActive, active);
                    releases.push(() => {
                        active -= 1;
                        resolve();
                    });
                }),
        });
        const queue = new PQueue({ concurrency: 2 });
        const strategies = Array.from({ length: 5 }, (_, index) =>
            strategy(`source-${index}`),
        );
        const orchestrator = new ScrapingOrchestrator(
            {} as DbOrTx,
            strategies,
            createDispatcher().dispatcher,
            queue,
        );

        orchestrator.start();
        for (let index = 0; index < 5; index++) {
            await waitFor(() => releases.length > index);
            at(releases, index)();
        }
        await queue.onIdle();
        orchestrator.stop();

        assert.equal(maxActive, 2);
    });

    it('drops queued-but-unstarted runs on stop', async () => {
        let started = 0;
        let release: (() => void) | undefined;
        const blocking: ScrapingStrategy = {
            ...reportStrategy(undefined),
            source: 'blocking',
            parse: async () => [],
            fetch: () =>
                new Promise<void>((resolve) => {
                    started += 1;
                    release = resolve;
                }),
        };
        const queued: ScrapingStrategy = {
            ...reportStrategy(undefined),
            source: 'queued',
            parse: async () => [],
            fetch: async () => {
                started += 1;
                return [];
            },
        };
        const orchestrator = new ScrapingOrchestrator(
            {} as DbOrTx,
            [blocking, queued],
            createDispatcher().dispatcher,
            new PQueue({ concurrency: 1 }),
        );

        orchestrator.start();
        await waitFor(() => started === 1);
        orchestrator.stop();
        release?.();
        await new Promise((resolve) => setTimeout(resolve, 20));

        assert.equal(started, 1, 'the queued run must never start after stop');
    });
});
