import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import { HTTPException } from 'hono/http-exception';
import { municipalities, reports } from '../src/core/schema.js';
import type { DbOrTx } from '../src/infrastructure/database/db.js';
import { createApp } from '../src/modules/api/app.js';
import {
    buildCursorCondition,
    buildPaginatedResponse,
} from '../src/modules/api/queries/util/cursor.js';
import { buildContainsPattern } from '../src/modules/api/queries/util/ilike.js';
import { eventsQuerySchema } from '../src/modules/api/validation/request/event.js';
import { municipalitiesQuerySchema } from '../src/modules/api/validation/request/municipality.js';
import {
    decodeCursor,
    encodeCursor,
    paginationQuerySchema,
} from '../src/modules/api/validation/request/pagination.js';
import { reportsQuerySchema } from '../src/modules/api/validation/request/report.js';
import { toEventDto } from '../src/modules/api/validation/response/event.js';
import { toMunicipalityDto } from '../src/modules/api/validation/response/municipality.js';
import { toReportDto } from '../src/modules/api/validation/response/report.js';
import { present } from './test-utils.js';

describe('API Layer, Cursor Pagination & Validation', () => {
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
        assert.match(new PgDialect().sqlToQuery(ascending).sql, />/);
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

    it('validates pagination and resource query boundaries', () => {
        assert.equal(
            paginationQuerySchema.safeParse({ pageSize: 0 }).success,
            false,
        );
        assert.equal(
            paginationQuerySchema.safeParse({ pageSize: 101 }).success,
            false,
        );
        assert.equal(
            paginationQuerySchema.safeParse({ cursor: 'broken' }).success,
            false,
        );
        assert.equal(
            reportsQuerySchema.safeParse({ status: 'bogus' }).success,
            false,
        );
        assert.equal(
            eventsQuerySchema.safeParse({ sortBy: 'title' }).success,
            false,
        );
        assert.equal(
            municipalitiesQuerySchema.safeParse({ lat: '41.9' }).success,
            false,
        );
        assert.equal(
            municipalitiesQuerySchema.safeParse({ lng: '21.4' }).success,
            false,
        );
    });

    it('escapes SQL LIKE wildcards (%, _, \\) in buildContainsPattern', () => {
        assert.equal(
            buildContainsPattern('100% _test\\path'),
            '%100\\% \\_test\\\\path%',
        );
    });

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
