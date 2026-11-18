import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { HTTPException } from 'hono/http-exception';
import { municipalities, reports } from '../src/core/schema.js';
import type { DbOrTx } from '../src/infrastructure/database/db.js';
import { logger } from '../src/infrastructure/logging/logger.js';
import { createApp } from '../src/modules/api/app.js';
import { findEvents } from '../src/modules/api/queries/events.queries.js';
import { findMunicipalities } from '../src/modules/api/queries/municipalities.queries.js';
import { findReports } from '../src/modules/api/queries/reports.queries.js';
import {
    buildCursorCondition,
    buildPaginatedResponse,
} from '../src/modules/api/queries/util/cursor.js';
import { buildContainsPattern } from '../src/modules/api/queries/util/ilike.js';
import { eventsQuerySchema } from '../src/modules/api/validation/request/event.js';
import { idParamSchema } from '../src/modules/api/validation/request/id.js';
import {
    municipalitiesQuerySchema,
    municipalityDetailQuerySchema,
} from '../src/modules/api/validation/request/municipality.js';
import {
    decodeCursor,
    encodeCursor,
    paginationQuerySchema,
} from '../src/modules/api/validation/request/pagination.js';
import { reportsQuerySchema } from '../src/modules/api/validation/request/report.js';
import { toEventDto } from '../src/modules/api/validation/response/event.js';
import { toMunicipalityDto } from '../src/modules/api/validation/response/municipality.js';
import { toReportDto } from '../src/modules/api/validation/response/report.js';
import { at, present, sqlParams, sqlText } from './util/assertions.js';
import { queryCapture } from './util/fakes.js';

describe('Cursor pagination and validation utilities', () => {
    it('encodes and decodes base64url cursors and rejects malformed cursors', () => {
        const cursor = encodeCursor({ v: '2026-10-25T00:00:00.000Z', id: 42 });
        assert.deepEqual(decodeCursor(cursor), {
            v: '2026-10-25T00:00:00.000Z',
            id: 42,
        });

        assert.equal(decodeCursor('not-valid-base64-json'), null);
        assert.equal(
            decodeCursor(Buffer.from('{"v":1,"id":-5}').toString('base64url')),
            null,
        );
    });

    it('safely returns null in buildCursorCondition when cursor valueType mismatches sortBy', () => {
        const dateCursor = encodeCursor({
            v: '2026-10-25T00:00:00.000Z',
            id: 10,
        });

        const mismatched = buildCursorCondition({
            cursor: dateCursor,
            sortExpr: reports.id,
            idColumn: reports.id,
            sortDirection: 'desc',
            valueType: 'number',
        });
        assert.equal(mismatched, null);

        const matched = buildCursorCondition({
            cursor: dateCursor,
            sortExpr: reports.observedAt,
            idColumn: reports.id,
            sortDirection: 'desc',
            valueType: 'date',
        });
        assert.notEqual(matched, null);

        const ascending = buildCursorCondition({
            cursor: encodeCursor({ v: 10, id: 3 }),
            sortExpr: reports.id,
            idColumn: reports.id,
            sortDirection: 'asc',
            valueType: 'number',
        });
        assert.ok(ascending);
        assert.match(sqlText(ascending), />/);
        assert.equal(
            buildCursorCondition({
                cursor: encodeCursor({ v: 'not-a-date', id: 2 }),
                sortExpr: reports.observedAt,
                idColumn: reports.id,
                sortDirection: 'desc',
                valueType: 'date',
            }),
            null,
        );
        assert.equal(
            buildCursorCondition({
                cursor: encodeCursor({ v: 0, id: 2 }),
                sortExpr: reports.id,
                idColumn: reports.id,
                sortDirection: 'desc',
                valueType: 'number',
            }),
            null,
        );
        assert.equal(
            buildCursorCondition({
                cursor: encodeCursor({ v: 123, id: 2 }),
                sortExpr: municipalities.code,
                idColumn: municipalities.id,
                sortDirection: 'desc',
                valueType: 'string',
            }),
            null,
        );
    });

    it('slices pageSize + 1 rows and computes hasNextPage and nextCursor accurately', () => {
        const rows = [
            { id: 3, name: 'C' },
            { id: 2, name: 'B' },
            { id: 1, name: 'A' },
        ];

        const page = buildPaginatedResponse(
            rows,
            2,
            (r) => r.id,
            (r) => r,
        );

        assert.equal(page.data.length, 2);
        assert.equal(page.meta.hasNextPage, true);
        assert.deepEqual(decodeCursor(present(page.meta.nextCursor)), {
            v: 2,
            id: 2,
        });

        const exactPage = buildPaginatedResponse(
            rows.slice(0, 2),
            2,
            (r) => r.id,
            (r) => r,
        );
        assert.equal(exactPage.meta.hasNextPage, false);
        assert.equal(exactPage.meta.nextCursor, null);

        const emptyPage = buildPaginatedResponse(
            [] as Array<{ id: number }>,
            2,
            (r) => r.id,
            (r) => r,
        );
        assert.deepEqual(emptyPage.data, []);
        assert.equal(emptyPage.meta.hasNextPage, false);
        assert.equal(emptyPage.meta.nextCursor, null);
    });

    it('escapes SQL LIKE wildcards (%, _, \\) in buildContainsPattern', () => {
        assert.equal(
            buildContainsPattern('100% _test\\path'),
            '%100\\% \\_test\\\\path%',
        );
    });

    it('maps response DTOs while omitting internal payload and geometry columns', () => {
        const now = new Date('2026-10-25T00:00:00.000Z');
        const report = toReportDto({
            id: 1,
            externalId: 'r-1',
            source: 'test',
            category: 'water',
            title: 'Report',
            description: null,
            municipalityCode: null,
            locationLabel: null,
            status: 'ongoing',
            rawPayload: { forensic: true },
            observedAt: now,
            startsAt: null,
            endsAt: null,
            scrapedAt: now,
            updatedAt: now,
            lng: null,
            lat: null,
        });
        assert.equal(report.coordinates, null);
        assert.equal('rawPayload' in report, false);
        assert.equal('scrapedAt' in report, false);
        const geocodedReport = toReportDto({
            id: 4,
            externalId: 'r-2',
            source: 'test',
            category: 'water',
            title: 'Geocoded',
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
            lng: 21.4,
            lat: 42,
        });
        assert.deepEqual(geocodedReport.coordinates, { lng: 21.4, lat: 42 });

        const event = toEventDto({
            id: 2,
            externalId: 'e-1',
            source: 'test',
            category: 'fuel_price',
            title: 'Event',
            description: null,
            status: 'ongoing',
            rawPayload: { forensic: true },
            observedAt: now,
            startsAt: null,
            endsAt: null,
            scrapedAt: now,
            updatedAt: now,
        });
        assert.equal('rawPayload' in event, false);
        assert.equal('updatedAt' in event, false);

        const municipality = toMunicipalityDto({
            id: 3,
            code: 'MK0080907',
            municipalityCode: 'MK008',
            nameMk: 'Карпош',
            nameEn: 'Karposh',
            regionCode: 'MK008',
            regionNameMk: 'Скопски',
            regionNameEn: 'Skopje',
            morphologicalType: 'urban',
            lng: 21.4,
            lat: 42,
            boundaryJson: JSON.stringify({
                type: 'MultiPolygon',
                coordinates: [
                    [
                        [
                            [21, 42],
                            [22, 42],
                            [22, 43],
                            [21, 42],
                        ],
                    ],
                ],
            }),
        });
        assert.deepEqual(municipality.center, { lng: 21.4, lat: 42 });
        assert.equal(municipality.boundary?.type, 'MultiPolygon');
        assert.equal('boundaryJson' in municipality, false);
        const municipalityWithoutBoundary = toMunicipalityDto({
            id: 4,
            code: 'MK0080908',
            municipalityCode: 'MK008',
            nameMk: 'Центар',
            nameEn: 'Centar',
            regionCode: 'MK008',
            regionNameMk: 'Скопски',
            regionNameEn: 'Skopje',
            morphologicalType: 'urban',
            lng: 21.4,
            lat: 42,
        });
        assert.equal(municipalityWithoutBoundary.boundary, undefined);
    });
});

describe('API routes, middleware, and error handling', () => {
    it('serves /api/ping, /api/ready (200 & 503), and validates spatial lat/lng pairs (400)', async () => {
        const healthyDb = {
            execute: async () => [{ '?column?': 1 }],
        } as unknown as DbOrTx;

        const app = createApp(healthyDb);

        const request = (url: string) =>
            app.request(url, { headers: { 'cf-connecting-ip': '127.0.0.1' } });

        const pingRes = await request('/api/ping');
        assert.equal(pingRes.status, 200);
        assert.deepEqual(await pingRes.json(), { message: 'pong' });

        const readyRes = await request('/api/ready');
        assert.equal(readyRes.status, 200);

        const badSpatialRes = await request('/api/reports?lat=41.9981');
        assert.equal(badSpatialRes.status, 400);
        const errBody = (await badSpatialRes.json()) as { message: string };
        assert.match(
            errBody.message,
            /Both lat and lng must be provided together/,
        );

        const brokenApp = createApp({
            execute: async () => {
                throw new Error('DB down');
            },
        } as unknown as DbOrTx);
        const unreadyRes = await brokenApp.request('/api/ready', {
            headers: { 'cf-connecting-ip': '127.0.0.1' },
        });
        assert.equal(unreadyRes.status, 503);

        const notFoundRes = await request('/api/not-a-route');
        assert.equal(notFoundRes.status, 404);
        assert.deepEqual(await notFoundRes.json(), {
            message: 'Route not found.',
        });
    });

    it('uses forwarded/socket IP fallbacks and rate-limits repeated client requests', async () => {
        const app = createApp({ execute: async () => [] } as unknown as DbOrTx);
        const forwarded = await app.request('/api/ping', {
            headers: { 'x-forwarded-for': '10.0.0.1, 10.0.0.2' },
        });
        assert.equal(forwarded.status, 200);

        const socketFallback = await app.request(
            '/api/ping',
            {},
            {
                incoming: {
                    socket: {
                        remoteAddress: '127.0.0.2',
                        remotePort: 1234,
                        remoteFamily: 'IPv4',
                    },
                },
            },
        );
        assert.equal(socketFallback.status, 200);

        const limitedApp = createApp({
            execute: async () => [],
        } as unknown as DbOrTx);
        let lastResponse: Response | undefined;
        for (let request = 0; request < 61; request++) {
            lastResponse = await limitedApp.request('/api/ping', {
                headers: {
                    'x-forwarded-for': `192.0.2.1, 192.0.2.${request}`,
                },
            });
        }
        assert.equal(lastResponse?.status, 429);
        assert.deepEqual(await lastResponse?.json(), {
            message: 'Too many requests, please try again later.',
        });
    });

    it('returns the generic 500 response when a query throws', async () => {
        const app = createApp({
            select: () => {
                throw new Error('query failed');
            },
        } as unknown as DbOrTx);
        const response = await app.request('/api/reports', {
            headers: { 'cf-connecting-ip': '198.51.100.1' },
        });
        assert.equal(response.status, 500);
        assert.deepEqual(await response.json(), {
            message: 'Internal server error.',
        });

        const exceptionApp = createApp({
            select: () => {
                throw new HTTPException(418, { message: 'teapot' });
            },
        } as unknown as DbOrTx);
        const exceptionResponse = await exceptionApp.request('/api/reports', {
            headers: { 'cf-connecting-ip': '198.51.100.2' },
        });
        assert.equal(exceptionResponse.status, 418);
        assert.match(await exceptionResponse.text(), /teapot/i);
    });

    it('mounts list/detail routes and returns validation errors and not-found responses', async () => {
        const chain = {
            where() {
                return chain;
            },
            orderBy() {
                return chain;
            },
            limit() {
                return Promise.resolve([]);
            },
        };
        const app = createApp({
            select: () => ({ from: () => chain }),
            execute: async () => [],
        } as unknown as DbOrTx);
        const request = (url: string) =>
            app.request(url, { headers: { 'cf-connecting-ip': '127.0.0.1' } });

        for (const url of [
            '/api/reports',
            '/api/events',
            '/api/municipalities',
        ]) {
            assert.equal((await request(url)).status, 200, `${url} list route`);
        }
        assert.equal((await request('/api/reports/1')).status, 404);
        assert.equal((await request('/api/events/1')).status, 404);
        assert.equal(
            (await request('/api/municipalities/MK0000000')).status,
            404,
        );
        assert.equal((await request('/api/reports/not-an-id')).status, 400);
        assert.equal((await request('/api/events/0')).status, 400);
        assert.equal(
            (await request('/api/events?category=invalid')).status,
            400,
        );
        assert.equal(
            (await request('/api/municipalities?lng=21.4')).status,
            400,
        );
    });

    it('returns detail rows and honors municipality boundary inclusion', async () => {
        const now = new Date('2026-10-25T00:00:00.000Z');
        const report = {
            id: 1,
            externalId: 'r-1',
            source: 'test',
            category: 'water',
            title: 'Report',
            description: null,
            municipalityCode: 'MK0080907',
            locationLabel: 'Карпош',
            status: 'ongoing',
            rawPayload: { internal: true },
            observedAt: now,
            startsAt: null,
            endsAt: null,
            scrapedAt: now,
            updatedAt: now,
            lng: 21.4,
            lat: 42,
        };
        const event = {
            id: 2,
            externalId: 'e-1',
            source: 'test',
            category: 'fuel_price',
            title: 'Event',
            description: null,
            status: 'ongoing',
            rawPayload: { internal: true },
            observedAt: now,
            startsAt: null,
            endsAt: null,
            scrapedAt: now,
            updatedAt: now,
        };
        const municipality = {
            id: 3,
            code: 'MK0080907',
            municipalityCode: 'MK008',
            nameMk: 'Карпош',
            nameEn: 'Karposh',
            regionCode: 'MK008',
            regionNameMk: 'Скопски',
            regionNameEn: 'Skopje',
            morphologicalType: 'urban',
            lng: 21.4,
            lat: 42,
            boundaryJson: JSON.stringify({
                type: 'MultiPolygon',
                coordinates: [
                    [
                        [
                            [21, 42],
                            [22, 42],
                            [22, 43],
                            [21, 42],
                        ],
                    ],
                ],
            }),
        };
        const rows: unknown[][] = [
            [report],
            [event],
            [municipality],
            [{ ...municipality, boundaryJson: undefined }],
        ];
        const db = {
            select: () => ({
                from: () => ({
                    where: () => ({ limit: async () => rows.shift() ?? [] }),
                }),
            }),
        } as unknown as DbOrTx;
        const app = createApp(db);
        const request = (url: string) =>
            app.request(url, {
                headers: { 'cf-connecting-ip': '203.0.113.1' },
            });

        const reportResponse = await request('/api/reports/1');
        assert.equal(reportResponse.status, 200);
        const reportBody = (await reportResponse.json()) as {
            data: {
                coordinates: { lng: number; lat: number };
                rawPayload?: unknown;
            };
        };
        assert.deepEqual(reportBody.data.coordinates, { lng: 21.4, lat: 42 });
        assert.equal('rawPayload' in reportBody.data, false);

        assert.equal((await request('/api/events/2')).status, 200);

        const municipalityResponse = await request(
            '/api/municipalities/MK0080907',
        );
        assert.equal(municipalityResponse.status, 200);
        const municipalityBody = (await municipalityResponse.json()) as {
            data: { boundary?: { type: string } };
        };
        assert.equal(municipalityBody.data.boundary?.type, 'MultiPolygon');

        const noBoundaryResponse = await request(
            '/api/municipalities/MK0080907?includeBoundary=false',
        );
        assert.equal(noBoundaryResponse.status, 200);
        const noBoundaryBody = (await noBoundaryResponse.json()) as {
            data: { boundary?: unknown };
        };
        assert.equal(noBoundaryBody.data.boundary, undefined);
    });
});

describe('API middleware contract', () => {
    const createHealthyApp = () =>
        createApp({
            execute: async () => [{ '?column?': 1 }],
        } as unknown as DbOrTx);

    it('redirects trailing-slash GETs with 301 to the trimmed path', async () => {
        const app = createHealthyApp();
        const response = await app.request('/api/ping/', {
            headers: { 'cf-connecting-ip': '127.0.0.1' },
        });
        assert.equal(response.status, 301);
        const location = present(response.headers.get('location'));
        assert.equal(new URL(location).pathname, '/api/ping');
    });

    it('serves wildcard CORS on GET and answers preflights with 204', async () => {
        const app = createHealthyApp();
        const getResponse = await app.request('/api/ping', {
            headers: { 'cf-connecting-ip': '127.0.0.1' },
        });
        assert.equal(
            getResponse.headers.get('access-control-allow-origin'),
            '*',
        );

        const preflight = await app.request('/api/ping', {
            method: 'OPTIONS',
            headers: {
                origin: 'https://example.test',
                'access-control-request-method': 'GET',
            },
        });
        assert.equal(preflight.status, 204);
        assert.equal(preflight.headers.get('access-control-allow-origin'), '*');
        assert.equal(
            preflight.headers.get('access-control-allow-methods'),
            'GET',
        );
        assert.equal(preflight.headers.get('access-control-max-age'), '600');
    });

    it('never echoes x-request-id and logs unhandled errors with a generated UUID', async () => {
        const app = createHealthyApp();
        const response = await app.request('/api/ping', {
            headers: {
                'cf-connecting-ip': '127.0.0.1',
                'x-request-id': 'client-supplied-id',
            },
        });
        assert.equal(response.headers.get('x-request-id'), null);

        const brokenApp = createApp({
            select: () => {
                throw new Error('query failed');
            },
        } as unknown as DbOrTx);
        const originalError = logger.error;
        const logged: string[] = [];
        logger.error = ((message: unknown) => {
            logged.push(String(message));
        }) as unknown as typeof logger.error;
        let errorResponse: Response | undefined;
        try {
            errorResponse = await brokenApp.request('/api/reports', {
                headers: { 'cf-connecting-ip': '198.51.100.9' },
            });
        } finally {
            logger.error = originalError;
        }
        assert.equal(errorResponse?.status, 500);
        assert.equal(logged.length, 1);
        assert.match(present(at(logged, 0)), /^\[Server:[0-9a-f-]{36}\]/i);
    });
});

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
        const where = sqlText(present(capture.where));
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
        const radiusParams = sqlParams(present(defaultRadius.capture.where));
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
        const where = sqlText(present(filtered.capture.where));
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
        const where = sqlText(present(capture.where));
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

describe('Request query schema boundaries (BVA)', () => {
    it('bounds pageSize at 1 and 100 and defaults municipalities to 100 (limit 101)', async () => {
        assert.equal(
            paginationQuerySchema.safeParse({ pageSize: 0 }).success,
            false,
        );
        assert.equal(
            paginationQuerySchema.safeParse({ pageSize: 1 }).success,
            true,
        );
        assert.equal(
            paginationQuerySchema.safeParse({ pageSize: 100 }).success,
            true,
        );
        assert.equal(
            paginationQuerySchema.safeParse({ pageSize: 101 }).success,
            false,
        );
        assert.equal(municipalitiesQuerySchema.parse({}).pageSize, 100);

        const { db, capture } = queryCapture([]);
        await findMunicipalities(db, municipalitiesQuerySchema.parse({}));
        assert.equal(capture.limit, 101);
    });

    it('bounds spatial radius at 50 and 50000 meters', () => {
        assert.equal(
            reportsQuerySchema.safeParse({ lat: 42, lng: 21.4, radius: 49 })
                .success,
            false,
        );
        assert.equal(
            reportsQuerySchema.safeParse({ lat: 42, lng: 21.4, radius: 50 })
                .success,
            true,
        );
        assert.equal(
            reportsQuerySchema.safeParse({
                lat: 42,
                lng: 21.4,
                radius: 50000,
            }).success,
            true,
        );
        assert.equal(
            reportsQuerySchema.safeParse({
                lat: 42,
                lng: 21.4,
                radius: 50001,
            }).success,
            false,
        );
    });

    it('bounds lat/lng ranges and rejects unpaired coordinates', () => {
        assert.equal(
            reportsQuerySchema.safeParse({ lat: -90.1, lng: 0 }).success,
            false,
        );
        assert.equal(
            reportsQuerySchema.safeParse({ lat: -90, lng: 0 }).success,
            true,
        );
        assert.equal(
            reportsQuerySchema.safeParse({ lat: 90, lng: 0 }).success,
            true,
        );
        assert.equal(
            reportsQuerySchema.safeParse({ lat: 90.1, lng: 0 }).success,
            false,
        );
        assert.equal(
            reportsQuerySchema.safeParse({ lat: 0, lng: -180.1 }).success,
            false,
        );
        assert.equal(
            reportsQuerySchema.safeParse({ lat: 0, lng: -180 }).success,
            true,
        );
        assert.equal(
            reportsQuerySchema.safeParse({ lat: 0, lng: 180 }).success,
            true,
        );
        assert.equal(
            reportsQuerySchema.safeParse({ lat: 0, lng: 180.1 }).success,
            false,
        );
        assert.equal(
            reportsQuerySchema.safeParse({ lat: 41.9 }).success,
            false,
        );
        assert.equal(
            reportsQuerySchema.safeParse({ lng: 21.4 }).success,
            false,
        );
    });

    it('bounds search length between 1 and 100 after trimming', () => {
        assert.equal(
            reportsQuerySchema.safeParse({ search: '' }).success,
            false,
        );
        assert.equal(
            reportsQuerySchema.safeParse({ search: '   ' }).success,
            false,
        );
        assert.equal(
            reportsQuerySchema.safeParse({ search: 'a' }).success,
            true,
        );
        assert.equal(
            reportsQuerySchema.safeParse({ search: 'a'.repeat(100) }).success,
            true,
        );
        assert.equal(
            reportsQuerySchema.safeParse({ search: 'a'.repeat(101) }).success,
            false,
        );
    });

    it('accepts asc/desc sort directions and rejects invalid sort fields, statuses, and categories', () => {
        assert.equal(reportsQuerySchema.parse({}).sortDirection, 'desc');
        assert.equal(
            reportsQuerySchema.parse({ sortDirection: 'asc' }).sortDirection,
            'asc',
        );
        assert.equal(
            reportsQuerySchema.parse({ sortDirection: 'desc' }).sortDirection,
            'desc',
        );
        assert.equal(
            reportsQuerySchema.safeParse({ sortDirection: 'up' }).success,
            false,
        );
        assert.equal(municipalitiesQuerySchema.parse({}).sortDirection, 'asc');
        assert.equal(
            reportsQuerySchema.safeParse({ sortBy: 'title' }).success,
            false,
        );
        assert.equal(
            eventsQuerySchema.safeParse({ sortBy: 'title' }).success,
            false,
        );
        assert.equal(
            reportsQuerySchema.safeParse({ status: '' }).success,
            false,
        );
        assert.equal(
            reportsQuerySchema.safeParse({ status: '   ' }).success,
            false,
        );
        assert.equal(
            reportsQuerySchema.safeParse({ status: 'bogus' }).success,
            false,
        );
        assert.equal(
            reportsQuerySchema.safeParse({ status: 'ongoing,scheduled' })
                .success,
            true,
        );
        assert.equal(
            reportsQuerySchema.safeParse({ category: 'not-a-category' })
                .success,
            false,
        );
        assert.equal(
            eventsQuerySchema.safeParse({ category: 'invalid' }).success,
            false,
        );
    });

    it('requires a positive integer id parameter', () => {
        assert.equal(idParamSchema.safeParse({ id: 0 }).success, false);
        assert.equal(idParamSchema.safeParse({ id: -1 }).success, false);
        assert.equal(
            idParamSchema.safeParse({ id: 'not-an-id' }).success,
            false,
        );
        assert.equal(idParamSchema.safeParse({ id: '1' }).success, true);
        assert.equal(idParamSchema.safeParse({ id: 1 }).success, true);
    });

    it('defaults includeBoundary to false for lists and true for detail', () => {
        assert.equal(
            municipalitiesQuerySchema.parse({}).includeBoundary,
            false,
        );
        assert.equal(
            municipalityDetailQuerySchema.parse({}).includeBoundary,
            true,
        );
        assert.equal(
            municipalitiesQuerySchema.safeParse({ includeBoundary: 'yes' })
                .success,
            false,
        );
        assert.equal(
            municipalityDetailQuerySchema.safeParse({ includeBoundary: 'yes' })
                .success,
            false,
        );
    });
});
