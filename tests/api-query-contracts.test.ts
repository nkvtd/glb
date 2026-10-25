import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { DbOrTx } from '../src/infrastructure/database/db.js';
import { findEvents } from '../src/modules/api/queries/events.queries.js';
import { findMunicipalities } from '../src/modules/api/queries/municipalities.queries.js';
import { findReports } from '../src/modules/api/queries/reports.queries.js';
import { eventsQuerySchema } from '../src/modules/api/validation/request/event.js';
import { municipalitiesQuerySchema } from '../src/modules/api/validation/request/municipality.js';
import { decodeCursor } from '../src/modules/api/validation/request/pagination.js';
import { reportsQuerySchema } from '../src/modules/api/validation/request/report.js';

function queryCapture(rows: unknown[] = []) {
    const capture: {
        where?: unknown;
        orderBy: unknown[];
        limit?: number;
        selectedKeys: string[];
    } = { orderBy: [], selectedKeys: [] };
    const chain = {
        where(value: unknown) {
            capture.where = value;
            return chain;
        },
        orderBy(...values: unknown[]) {
            capture.orderBy = values;
            return chain;
        },
        limit(value: number) {
            capture.limit = value;
            return Promise.resolve(rows);
        },
    };
    const db = {
        select: (columns?: unknown) => {
            capture.selectedKeys =
                columns && typeof columns === 'object'
                    ? Object.keys(columns)
                    : [];
            return { from: () => chain };
        },
    } as unknown as DbOrTx;
    return { db, capture };
}

function sqlText(value: unknown): string {
    assert.ok(value && typeof value === 'object' && 'queryChunks' in value);
    return new PgDialect().sqlToQuery(value as never).sql;
}

describe('API query construction', () => {
    it('builds report filters, escaped search, date range, spatial query, cursor and page limit', async () => {
        const { db, capture } = queryCapture();
        const query = reportsQuerySchema.parse({
            status: 'ongoing,scheduled',
            category: 'power,water',
            source: 'evn',
            municipalityCode: 'MK0080907',
            search: '100%_test',
            from: '2026-01-01T00:00:00Z',
            to: '2026-12-31T23:59:59Z',
            lat: '42',
            lng: '21.4',
            radius: '1500',
            sortBy: 'startsAt',
            sortDirection: 'asc',
            cursor: Buffer.from(
                JSON.stringify({ v: '2026-06-01T00:00:00.000Z', id: 5 }),
            ).toString('base64url'),
            pageSize: '10',
        });
        const result = await findReports(db, query);
        const where = sqlText(capture.where);
        assert.match(where, /"reports"\."status"/);
        assert.match(where, /"reports"\."category"/);
        assert.match(where, /"reports"\."source"/);
        assert.match(where, /"reports"\."municipality_code"/);
        assert.match(where, /ilike/i);
        assert.match(where, /COALESCE/);
        assert.match(where, /ST_DWithin/);
        assert.match(where, /municipalities/);
        assert.equal(capture.limit, 11);
        assert.equal(capture.orderBy.length, 2);
        assert.deepEqual(result.data, []);
        assert.equal(result.meta.hasNextPage, false);

        const defaultRadius = queryCapture();
        await findReports(
            defaultRadius.db,
            reportsQuerySchema.parse({ lat: 42, lng: 21.4 }),
        );
        const radiusParams = new PgDialect().sqlToQuery(
            defaultRadius.capture.where as never,
        ).params;
        assert.equal(radiusParams.filter((value) => value === 5000).length, 2);
    });

    it('builds event filters and supports empty/unfiltered queries', async () => {
        const filtered = queryCapture();
        const query = eventsQuerySchema.parse({
            status: 'ongoing',
            category: 'fuel_price',
            source: 'amsm-fuel',
            search: 'fuel',
            from: '2026-01-01',
            to: '2026-12-31',
            sortBy: 'endsAt',
            sortDirection: 'desc',
            pageSize: 3,
        });
        await findEvents(filtered.db, query);
        const where = sqlText(filtered.capture.where);
        assert.match(where, /"events"\."status"/);
        assert.match(where, /"events"\."category"/);
        assert.match(where, /"events"\."source"/);
        assert.match(where, /ilike/i);
        assert.match(where, /COALESCE/);
        assert.equal(filtered.capture.limit, 4);

        const empty = queryCapture();
        await findEvents(empty.db, eventsQuerySchema.parse({}));
        assert.equal(empty.capture.where, undefined);
        assert.equal(empty.capture.limit, 21);
    });

    it('builds municipality search, filters, point-in-polygon query and string cursor', async () => {
        const { db, capture } = queryCapture();
        const query = municipalitiesQuerySchema.parse({
            regionCode: 'mk008',
            municipalityCode: 'mk008',
            morphologicalType: 'urban',
            search: 'skopje',
            lat: '42',
            lng: '21.4',
            includeBoundary: 'false',
            sortBy: 'nameMk',
            sortDirection: 'asc',
            cursor: Buffer.from(
                JSON.stringify({ v: 'Аеродром', id: 2 }),
            ).toString('base64url'),
            pageSize: 5,
        });
        await findMunicipalities(db, query);
        const where = sqlText(capture.where);
        assert.match(where, /"municipalities"\."region_code"/);
        assert.match(where, /"municipalities"\."municipality_code"/);
        assert.match(where, /"municipalities"\."morphological_type"/);
        assert.match(where, /ilike/i);
        assert.match(where, /ST_Covers/);
        assert.equal(capture.limit, 6);
        assert.equal(capture.orderBy.length, 2);
    });

    it('extracts cursor values for each report and event sort field with nullable dates', async () => {
        const now = new Date('2026-10-25T00:00:00.000Z');
        const later = new Date('2026-10-26T00:00:00.000Z');
        const reportRows = [
            {
                id: 10,
                externalId: 'r-10',
                source: 'test',
                category: 'water',
                title: 'Report 10',
                description: null,
                municipalityCode: null,
                locationLabel: null,
                status: 'ongoing',
                rawPayload: null,
                observedAt: now,
                startsAt: null,
                endsAt: null,
                scrapedAt: now,
                updatedAt: now,
                lng: null,
                lat: null,
            },
            {
                id: 11,
                externalId: 'r-11',
                source: 'test',
                category: 'water',
                title: 'Report 11',
                description: null,
                municipalityCode: null,
                locationLabel: null,
                status: 'ongoing',
                rawPayload: null,
                observedAt: later,
                startsAt: null,
                endsAt: null,
                scrapedAt: later,
                updatedAt: later,
                lng: null,
                lat: null,
            },
        ];
        for (const sortBy of [
            'id',
            'observedAt',
            'startsAt',
            'endsAt',
        ] as const) {
            const capture = queryCapture(reportRows);
            const result = await findReports(
                capture.db,
                reportsQuerySchema.parse({ sortBy, pageSize: 1 }),
            );
            assert.equal(result.meta.hasNextPage, true);
            const expected = sortBy === 'id' ? 10 : now.toISOString();
            assert.deepEqual(decodeCursor(result.meta.nextCursor ?? ''), {
                v: expected,
                id: 10,
            });
        }

        const eventRows = [
            {
                id: 20,
                externalId: 'e-20',
                source: 'test',
                category: 'fuel_price',
                title: 'Event 20',
                description: null,
                status: 'ongoing',
                rawPayload: null,
                observedAt: now,
                startsAt: null,
                endsAt: null,
                scrapedAt: now,
                updatedAt: now,
            },
            {
                id: 21,
                externalId: 'e-21',
                source: 'test',
                category: 'fuel_price',
                title: 'Event 21',
                description: null,
                status: 'ongoing',
                rawPayload: null,
                observedAt: later,
                startsAt: null,
                endsAt: null,
                scrapedAt: later,
                updatedAt: later,
            },
        ];
        for (const sortBy of [
            'id',
            'observedAt',
            'startsAt',
            'endsAt',
        ] as const) {
            const capture = queryCapture(eventRows);
            const result = await findEvents(
                capture.db,
                eventsQuerySchema.parse({ sortBy, pageSize: 1 }),
            );
            const expected = sortBy === 'id' ? 20 : now.toISOString();
            assert.deepEqual(decodeCursor(result.meta.nextCursor ?? ''), {
                v: expected,
                id: 20,
            });
        }
    });

    it('extracts each municipality sort value and selects boundaries only when requested', async () => {
        const rows = [
            {
                id: 1,
                code: 'MK0080901',
                municipalityCode: 'MK008',
                nameMk: 'Аеродром',
                nameEn: 'Aerodrom',
                regionCode: 'MK008',
                regionNameMk: 'Скопски',
                regionNameEn: 'Skopje',
                morphologicalType: 'urban',
                lng: 21.4,
                lat: 42,
            },
            {
                id: 2,
                code: 'MK0080904',
                municipalityCode: 'MK008',
                nameMk: 'Гази Баба',
                nameEn: 'Gazi Baba',
                regionCode: 'MK008',
                regionNameMk: 'Скопски',
                regionNameEn: 'Skopje',
                morphologicalType: 'urban',
                lng: 21.5,
                lat: 42.1,
            },
        ];
        for (const sortBy of ['id', 'code', 'nameMk', 'nameEn'] as const) {
            const capture = queryCapture(rows);
            const result = await findMunicipalities(
                capture.db,
                municipalitiesQuerySchema.parse({ sortBy, pageSize: 1 }),
            );
            const expected =
                sortBy === 'id'
                    ? 1
                    : sortBy === 'code'
                      ? 'MK0080901'
                      : sortBy === 'nameMk'
                        ? 'Аеродром'
                        : 'Aerodrom';
            assert.deepEqual(decodeCursor(result.meta.nextCursor ?? ''), {
                v: expected,
                id: 1,
            });
        }

        const withoutBoundary = queryCapture([]);
        await findMunicipalities(
            withoutBoundary.db,
            municipalitiesQuerySchema.parse({ includeBoundary: 'false' }),
        );
        assert.equal(
            withoutBoundary.capture.selectedKeys.includes('boundaryJson'),
            false,
        );

        const withBoundary = queryCapture([]);
        await findMunicipalities(
            withBoundary.db,
            municipalitiesQuerySchema.parse({ includeBoundary: 'true' }),
        );
        assert.equal(
            withBoundary.capture.selectedKeys.includes('boundaryJson'),
            true,
        );
    });
});
