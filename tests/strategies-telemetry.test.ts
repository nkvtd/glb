import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { emscResponseSchema } from '../src/core/validation/emsc.js';
import type { NbrmRateItem } from '../src/core/validation/nbrm-rates.js';
import type { WorldFiresHotspot } from '../src/core/validation/worldfires.js';
import { worldFiresHotspotsResponseSchema } from '../src/core/validation/worldfires.js';
import { AmsmFuelStrategy } from '../src/modules/scraping/strategies/amsm-fuel.strategy.js';
import { EmscStrategy } from '../src/modules/scraping/strategies/emsc.strategy.js';
import { IodaEventsStrategy } from '../src/modules/scraping/strategies/ioda-events.strategy.js';
import { IodaReportsStrategy } from '../src/modules/scraping/strategies/ioda-reports.strategy.js';
import { MoeppStrategy } from '../src/modules/scraping/strategies/moepp.strategy.js';
import { NbrmRatesStrategy } from '../src/modules/scraping/strategies/nbrm-rates.strategy.js';
import { SensorCommunityStrategy } from '../src/modules/scraping/strategies/sensor-community.strategy.js';
import { WorldFiresStrategy } from '../src/modules/scraping/strategies/worldfires.strategy.js';
import { at, present } from './util/assertions.js';
import { withFrozenClock } from './util/clock.js';
import {
    createFakeResolver,
    createStandardFakeResolver,
} from './util/fakes.js';
import {
    emptyResponse,
    jsonResponse,
    textResponse,
    withFetch,
} from './util/fetch-mock.js';
import {
    emscFeature,
    fuel,
    measurement,
    sensor,
    station,
    worldFiresHotspot,
} from './util/fixtures.js';

const resolver = createStandardFakeResolver();

// Wall-clock-dependent strategies are frozen at a fixed mid-day instant so
// window boundaries never drift with the real clock.
const frozenNow = new Date('2026-11-18T12:00:00.000Z');

describe('MoeppStrategy', () => {
    describe('fetch()', () => {
        it('fetches stations via GET then posts their IDs to retrieve measurements', async () => {
            const calls: Array<{
                url: string;
                method: string;
                body?: string | null;
            }> = [];
            await withFetch(
                async (input, init) => {
                    calls.push({
                        url: String(input),
                        method: init?.method ?? 'GET',
                        body: init?.body as string | null,
                    });
                    return calls.length === 1
                        ? jsonResponse([station])
                        : jsonResponse([measurement]);
                },
                async () => {
                    const result = await new MoeppStrategy(
                        'https://moepp.test/api',
                        '* * * * *',
                        createFakeResolver(),
                    ).fetch();
                    assert.equal(result.stations.length, 1);
                    assert.equal(result.measurements.length, 1);
                },
            );
            assert.deepEqual(
                calls.map((call) => call.method),
                ['GET', 'POST'],
            );
            assert.deepEqual(
                (
                    JSON.parse(present(at(calls, 1).body)) as {
                        StationIds: number[];
                    }
                ).StationIds,
                [7],
            );
        });

        it('posts the Skopje calendar date, not the host date', async () => {
            let body = '';
            await withFrozenClock(
                new Date('2026-11-18T23:30:00Z'),
                async () => {
                    await withFetch(
                        async (_input, init) => {
                            if (init?.method === 'POST') {
                                body = String(init.body);
                                return jsonResponse([measurement]);
                            }
                            return jsonResponse([station]);
                        },
                        async () => {
                            await new MoeppStrategy(
                                'https://moepp.test/api',
                                '* * * * *',
                                createFakeResolver(),
                            ).fetch();
                        },
                    );
                },
            );
            const payload = JSON.parse(body) as {
                DateFrom: string;
                DateTo: string;
            };
            assert.equal(payload.DateFrom, '2026-11-19');
            assert.equal(payload.DateTo, '2026-11-19');
        });

        it('rejects GET failures', async () => {
            await withFetch(
                async () => textResponse('station error', 500),
                async () => {
                    await assert.rejects(
                        new MoeppStrategy(
                            'https://moepp.test/api',
                            '* * * * *',
                            createFakeResolver(),
                        ).fetch(),
                        /Fetch failed with status code 500: station error/,
                    );
                },
            );
        });

        it('rejects POST failures', async () => {
            await withFetch(
                async (_input, init) =>
                    init?.method === 'POST'
                        ? textResponse('measurement error', 500)
                        : jsonResponse([station]),
                async () => {
                    await assert.rejects(
                        new MoeppStrategy(
                            'https://moepp.test/api',
                            '* * * * *',
                            createFakeResolver(),
                        ).fetch(),
                        /Fetch failed with status code 500: measurement error/,
                    );
                },
            );
        });
    });

    describe('parse()', () => {
        it('marks poor indices ongoing, non-poor indices omitted, with stateFeed enabled', async () => {
            const strategy = new MoeppStrategy(
                'http://moepp.test',
                '*/30 * * * *',
                resolver,
            );
            assert.equal(strategy.stateFeed, true);

            const stations = [
                {
                    id: 10,
                    code: 'SK1',
                    name: 'Лисиче',
                    longitude: 21.46,
                    latitude: 41.97,
                    isActive: true,
                    created: '2020-01-01',
                    regionID: 8,
                    city: 'Скопје - Аеродром',
                    typeOfStation: 'Background',
                    areaType: 'Urban',
                    address: 'Лисиче',
                    altituda: 240,
                    pollutants: 'PM10,PM25',
                    cityEN: 'Skopje',
                    addressEN: 'Lisice',
                    areaTypeEN: 'Urban',
                    typeOfStationEN: 'Background',
                    nameEN: 'Lisice',
                },
            ];

            const measurements = [
                {
                    stationID: 10,
                    stationName: 'Лисиче',
                    stationNameEN: 'Lisice',
                    fromTime: '2026-10-25T08:00:00',
                    toTime: '2026-10-25T09:00:00',
                    aQ_Value: 88.4,
                    aQ_Index: {
                        code: '04',
                        color: '#ff0000',
                        name: 'Лош',
                        nameEN: 'Poor',
                    },
                    pM10_Value: 88.4,
                    pM10_Index: {
                        code: '04',
                        color: '#ff0000',
                        name: 'Лош',
                        nameEN: 'Poor',
                    },
                    pM25_Value: 42.1,
                    pM25_Index: {
                        code: '04',
                        color: '#ff0000',
                        name: 'Лош',
                        nameEN: 'Poor',
                    },
                    cO_Value: null,
                    cO_Index: {
                        code: '08',
                        color: '#ccc',
                        name: 'Нема',
                        nameEN: 'None',
                    },
                    nO2_Value: null,
                    nO2_Index: null,
                    o3_Value: null,
                    o3_Index: null,
                    sO2_Value: null,
                    sO2_Index: null,
                },
            ];

            const parsed = await strategy.parse({ stations, measurements });
            assert.equal(parsed.length, 1);
            const poorReport = at(parsed, 0);
            assert.equal(poorReport.status, 'ongoing');
            assert.equal(
                present(poorReport.startsAt).toISOString(),
                '2026-10-25T08:00:00.000Z',
            );
            const parseLocalTimestamp = (
                strategy as unknown as {
                    parseLocalTimestamp(raw: string): Date;
                }
            ).parseLocalTimestamp.bind(strategy);
            assert.equal(
                parseLocalTimestamp('2026-06-15T09:00:00').toISOString(),
                '2026-06-15T07:00:00.000Z',
            );
            assert.equal(
                poorReport.title,
                'Лош квалитет на воздух: Лисиче, Аеродром',
            );
            assert.match(
                present(poorReport.description),
                /PM10 од 88.4 µg\/m³ \(лош\) и PM2.5 од 42.1 µg\/m³ \(лош\)/,
            );

            const byIndex = await strategy.parse({
                stations,
                measurements: ['01', '02', '03', '04', '05', '06'].map(
                    (code, index) => ({
                        ...at(measurements, 0),
                        fromTime: `2026-10-25T0${index}:00:00`,
                        aQ_Index: {
                            ...present(at(measurements, 0).aQ_Index),
                            code,
                        },
                    }),
                ),
            });
            assert.deepEqual(
                byIndex.map((report) => report.status),
                [
                    'omitted',
                    'omitted',
                    'omitted',
                    'ongoing',
                    'ongoing',
                    'ongoing',
                ],
            );

            const noData = await strategy.parse({
                stations,
                measurements: [
                    {
                        ...at(measurements, 0),
                        stationID: 999,
                    },
                    {
                        ...at(measurements, 0),
                        aQ_Value: null,
                        aQ_Index: null,
                        cO_Value: null,
                        cO_Index: null,
                        nO2_Value: null,
                        nO2_Index: null,
                        o3_Value: null,
                        o3_Index: null,
                        pM25_Value: null,
                        pM25_Index: null,
                        pM10_Value: null,
                        pM10_Index: null,
                        sO2_Value: null,
                        sO2_Index: null,
                    },
                ],
            });
            assert.equal(noData.length, 1, 'unknown station IDs are skipped');
            assert.match(
                at(noData, 0).title,
                /Квалитет на воздух \(нема податоци\)/,
            );
            assert.match(
                present(at(noData, 0).description),
                /моментално нема податоци/,
            );

            const onePollutant = await strategy.parse({
                stations,
                measurements: [
                    {
                        ...at(measurements, 0),
                        pM10_Value: 55,
                        pM10_Index: at(measurements, 0).pM10_Index,
                        pM25_Value: null,
                        pM25_Index: null,
                        cO_Value: null,
                        cO_Index: null,
                        nO2_Value: null,
                        nO2_Index: null,
                        o3_Value: null,
                        o3_Index: null,
                        sO2_Value: null,
                        sO2_Index: null,
                    },
                ],
            });
            assert.match(
                present(at(onePollutant, 0).description),
                /Измерена е концентрација на PM10/,
            );

            const sameNameStation = {
                ...at(stations, 0),
                city: 'Лисиче',
            };
            const sameName = await strategy.parse({
                stations: [sameNameStation],
                measurements: [at(measurements, 0)],
            });
            assert.equal(at(sameName, 0).locationLabel, 'Лисиче');
            assert.match(
                present(at(sameName, 0).description),
                /На мерната станица во Лисиче/,
            );

            const resolutionCalls: string[] = [];
            const fallbackStrategy = new MoeppStrategy(
                'http://moepp.test',
                '*/30 * * * *',
                createFakeResolver({
                    coords: null,
                    text: (text) => {
                        resolutionCalls.push(text ?? '');
                        return text === 'Address Z' ? 'MK0080907' : null;
                    },
                }),
            );
            const fallback = await fallbackStrategy.parse({
                stations: [
                    {
                        ...at(stations, 0),
                        name: 'Station X',
                        city: 'City Y',
                        address: 'Address Z',
                    },
                ],
                measurements: [at(measurements, 0)],
            });
            assert.equal(at(fallback, 0).municipalityCode, 'MK0080907');
            assert.deepEqual(resolutionCalls, [
                'Station X',
                'City Y',
                'Address Z',
            ]);
        });
    });
});

describe('SensorCommunityStrategy', () => {
    const strategy = new SensorCommunityStrategy(
        'http://sensor.test',
        '*/15 * * * *',
        resolver,
    );

    const makePacket = (pm10: number, pm25?: number) => ({
        id: pm10,
        timestamp: '2026-10-25 12:00:00',
        sensor: {
            id: pm10,
            sensor_type: {
                id: 14,
                name: 'SDS011',
                manufacturer: 'Nova',
            },
        },
        location: {
            id: pm10,
            latitude: 42,
            longitude: 21.42,
            altitude: 250,
            country: 'MK',
            indoor: 0,
        },
        sensordatavalues: [
            { value_type: 'P1', value: pm10 },
            ...(pm25 === undefined ? [] : [{ value_type: 'P2', value: pm25 }]),
        ],
    });

    describe('fetch()', () => {
        it('fetches and validates the upstream payload', async () => {
            await withFetch(
                async () => jsonResponse([sensor]),
                async () => {
                    const result = await strategy.fetch();
                    assert.ok(Array.isArray(result));
                },
            );
        });

        it('rejects non-OK responses', async () => {
            await withFetch(
                async () => textResponse('provider error', 500),
                async () => {
                    await assert.rejects(
                        strategy.fetch(),
                        /Fetch failed with status code 500: provider error/,
                    );
                },
            );
        });
    });

    describe('parse()', () => {
        it('strictly filters indoor, dead fans (<=0.5), fog (>=90% humidity), and computes trimmed mean', async () => {
            assert.equal(strategy.stateFeed, true);

            const makePacket = (
                locId: number,
                indoor: number,
                values: Array<{ value_type: string; value: number }>,
            ) => ({
                id: locId * 10,
                timestamp: '2026-10-25 10:15:00',
                sensor: {
                    id: locId,
                    sensor_type: {
                        id: 14,
                        name: 'SDS011',
                        manufacturer: 'Nova',
                    },
                },
                location: {
                    id: locId,
                    latitude: 42.0,
                    longitude: 21.42,
                    altitude: 250,
                    country: 'MK',
                    indoor,
                },
                sensordatavalues: values,
            });

            const raw = [
                // 1. Rejected: indoor === 1
                makePacket(1, 1, [
                    { value_type: 'P1', value: 500 },
                    { value_type: 'P2', value: 200 },
                ]),
                // 2. Rejected: dead fan (P1 <= 0.5)
                makePacket(2, 0, [
                    { value_type: 'P1', value: 0.2 },
                    { value_type: 'P2', value: 0.2 },
                ]),
                // 3. Rejected: fog condensation (humidity >= 90% at same locationId)
                makePacket(3, 0, [
                    { value_type: 'P1', value: 150 },
                    { value_type: 'P2', value: 80 },
                    { value_type: 'humidity', value: 95 },
                ]),
                // 4. Rejected: broken ratio (P2 > P1 * 1.05)
                makePacket(4, 0, [
                    { value_type: 'P1', value: 10 },
                    { value_type: 'P2', value: 25 },
                ]),
                // 5-8. Four valid stations in Karpoš (triggers 20% trimmed mean: drops 10 and 200, averages 60 and 70 -> 65)
                makePacket(5, 0, [
                    { value_type: 'P1', value: 10 },
                    { value_type: 'P2', value: 5 },
                ]),
                makePacket(6, 0, [
                    { value_type: 'P1', value: 60 },
                    { value_type: 'P2', value: 30 },
                ]),
                makePacket(7, 0, [
                    { value_type: 'P1', value: 70 },
                    { value_type: 'P2', value: 34 },
                ]),
                makePacket(8, 0, [
                    { value_type: 'P1', value: 200 },
                    { value_type: 'P2', value: 90 },
                ]),
            ];

            const parsed = await strategy.parse(raw);
            assert.equal(parsed.length, 1);

            const report = at(parsed, 0);
            assert.equal(report.municipalityCode, 'MK0080907');
            assert.equal(report.locationLabel, 'Карпош');
            assert.equal(report.externalId, 'MK0080907-2026-10-25T10:00:00Z');
            // Trimmed mean of [10, 60, 70, 200] trims 1 from each end -> mean(60, 70) = 65
            assert.equal(report.rawPayload.averages.pm10, 65);
            assert.equal(report.rawPayload.averages.pm25, 32);
            assert.equal(report.status, 'ongoing'); // 65 > 50 -> '04' (Лош) -> 'ongoing'
            assert.equal(report.title, 'Лош квалитет на воздух: Карпош');
        });

        it('accepts the exact PM2.5/PM10 ratio limit and rejects saturated humidity', async () => {
            const makePacket = (
                locationId: number,
                values: Array<{ value_type: string; value: number }>,
                timestamp = '2026-10-25 10:59:00',
            ) => ({
                id: locationId,
                timestamp,
                sensor: {
                    id: locationId,
                    sensor_type: {
                        id: 14,
                        name: 'SDS011',
                        manufacturer: 'Nova',
                    },
                },
                location: {
                    id: locationId,
                    latitude: 42,
                    longitude: 21.42,
                    altitude: 250,
                    country: 'MK',
                    indoor: 0,
                },
                sensordatavalues: values,
            });

            const parsed = await strategy.parse([
                makePacket(11, [
                    { value_type: 'P1', value: 100 },
                    { value_type: 'P2', value: 105 },
                    { value_type: 'humidity', value: 89 },
                ]),
                makePacket(12, [
                    { value_type: 'P1', value: 200 },
                    { value_type: 'P2', value: 50 },
                    { value_type: 'humidity', value: 90 },
                ]),
            ]);
            assert.equal(parsed.length, 1);
            const report = at(parsed, 0);
            assert.equal(report.rawPayload.averages.pm10, 100);
            assert.equal(report.rawPayload.averages.pm25, 105);
            assert.ok(report.startsAt instanceof Date);
            assert.equal(
                report.startsAt?.toISOString(),
                '2026-10-25T10:59:00.000Z',
            );
            assert.equal(report.externalId, 'MK0080907-2026-10-25T10:00:00Z');
        });

        it('averages same-station packets, normalizes pressure and formats weather', async () => {
            const makePacket = (
                timestamp: string,
                values: Array<{ value_type: string; value: number }>,
            ) => ({
                id: 50,
                timestamp,
                sensor: {
                    id: 500,
                    sensor_type: {
                        id: 14,
                        name: 'SDS011',
                        manufacturer: 'Nova',
                    },
                },
                location: {
                    id: 50,
                    latitude: 42,
                    longitude: 21.42,
                    altitude: 250,
                    country: 'MK',
                    indoor: 0,
                },
                sensordatavalues: values,
            });
            const averaged = await strategy.parse([
                makePacket('2026-10-25 10:15:00', [
                    { value_type: 'P1', value: 10 },
                    { value_type: 'P2', value: 5 },
                    { value_type: 'temperature', value: 20 },
                    { value_type: 'humidity', value: 50 },
                    { value_type: 'pressure', value: 101325 },
                ]),
                makePacket('2026-10-25 10:45:00', [
                    { value_type: 'P1', value: 12 },
                    { value_type: 'P2', value: 6 },
                    { value_type: 'temperature', value: 22 },
                    { value_type: 'humidity', value: 60 },
                    { value_type: 'pressure', value: 101315 },
                ]),
            ]);
            const report = at(averaged, 0);
            assert.equal(report.rawPayload.activeStationCount, 1);
            assert.equal(report.rawPayload.averages.pm10, 11);
            assert.equal(report.rawPayload.averages.pm25, 5.5);
            assert.equal(report.rawPayload.averages.temperature, 21);
            assert.equal(report.rawPayload.averages.humidity, 55);
            assert.equal(report.rawPayload.averages.pressureHpa, 1013.2);
            assert.equal(
                report.startsAt?.toISOString(),
                '2026-10-25T10:45:00.000Z',
            );
            assert.match(
                present(report.description),
                /1 активна мерна станица/,
            );
            assert.match(present(report.description), /температура од 21 °C/);
            assert.match(
                present(report.description),
                /релативна влажност од 55%/,
            );
        });

        it('covers every pollution band, PM2.5 dominance, PM10-only and unmapped stations', async () => {
            const bands: Array<[number, string]> = [
                [10, '01'],
                [30, '02'],
                [45, '03'],
                [60, '04'],
                [120, '05'],
                [200, '06'],
            ];
            for (const [pm10, code] of bands) {
                const result = await strategy.parse([makePacket(pm10)]);
                assert.equal(at(result, 0).rawPayload.classificationCode, code);
            }
            const pm25Dominates = await strategy.parse([makePacket(30, 30)]);
            assert.equal(
                at(pm25Dominates, 0).rawPayload.classificationCode,
                '04',
            );

            const pm10Only = await strategy.parse([makePacket(10)]);
            assert.equal(at(pm10Only, 0).rawPayload.averages.pm25, null);
            assert.doesNotMatch(present(at(pm10Only, 0).description), /PM2\.5/);

            const unmapped = new SensorCommunityStrategy(
                'http://sensor.test',
                '*/15 * * * *',
                createFakeResolver({ coords: null }),
            );
            assert.deepEqual(await unmapped.parse([makePacket(60)]), []);
        });

        it('pins PM10/PM2.5 band boundaries, the fog floor, the ratio limit and the trimmed-mean cutoff', async () => {
            const pm10Boundaries: Array<[number, string]> = [
                [20, '01'],
                [20.1, '02'],
                [40, '02'],
                [40.1, '03'],
                [50, '03'],
                [50.1, '04'],
                [100, '04'],
                [100.1, '05'],
                [150, '05'],
                [150.1, '06'],
            ];
            for (const [pm10, code] of pm10Boundaries) {
                const [report] = await strategy.parse([makePacket(pm10)]);
                assert.equal(
                    present(report).rawPayload.classificationCode,
                    code,
                );
            }

            // PM2.5 boundaries up to 20.1 stay measurable with P1 = 20 (band '01')
            const lowPm25: Array<[number, string]> = [
                [10, '01'],
                [10.1, '02'],
                [20, '02'],
                [20.1, '03'],
            ];
            for (const [pm25, code] of lowPm25) {
                const [report] = await strategy.parse([makePacket(20, pm25)]);
                assert.equal(
                    present(report).rawPayload.classificationCode,
                    code,
                );
            }

            // Above 20.1 the ratio needs P1 = P2; the PM10 band of the same value never exceeds the PM2.5 band
            const highPm25: Array<[number, string]> = [
                [25, '03'],
                [25.1, '04'],
                [50, '04'],
                [50.1, '05'],
                [75, '05'],
                [75.1, '06'],
            ];
            for (const [pm25, code] of highPm25) {
                const [report] = await strategy.parse([makePacket(pm25, pm25)]);
                assert.equal(
                    present(report).rawPayload.classificationCode,
                    code,
                );
            }

            const fogPacket = (humidity: number) => ({
                id: 1,
                timestamp: '2026-10-25 12:00:00',
                sensor: {
                    id: 1,
                    sensor_type: {
                        id: 14,
                        name: 'SDS011',
                        manufacturer: 'Nova',
                    },
                },
                location: {
                    id: 1,
                    latitude: 42,
                    longitude: 21.42,
                    altitude: 250,
                    country: 'MK',
                    indoor: 0,
                },
                sensordatavalues: [
                    { value_type: 'P1', value: 60 },
                    { value_type: 'P2', value: 30 },
                    { value_type: 'humidity', value: humidity },
                ],
            });
            const dry = at(await strategy.parse([fogPacket(89.9)]), 0);
            assert.equal(dry.rawPayload.averages.humidity, 89.9);
            assert.equal(dry.rawPayload.averages.pm10, 60);
            assert.deepEqual(await strategy.parse([fogPacket(90)]), []);

            // P2 = P1 * 1.05 exactly is accepted; 1.051 is not
            const atLimit = at(await strategy.parse([makePacket(100, 105)]), 0);
            assert.equal(atLimit.rawPayload.averages.pm25, 105);
            assert.deepEqual(
                await strategy.parse([makePacket(100, 105.1)]),
                [],
            );

            // Fewer than 4 samples use the plain mean instead of the trimmed mean
            const threeStations = await strategy.parse([
                makePacket(10, 5),
                makePacket(60, 30),
                makePacket(70, 34),
            ]);
            assert.equal(at(threeStations, 0).rawPayload.averages.pm10, 46.7);
        });
    });
});

describe('EmscStrategy', () => {
    const strategy = new EmscStrategy(
        'https://emsc.test/query?minmag=2.0',
        '*/10 * * * *',
        resolver,
    );

    function makeEmscFeature(overrides: Record<string, unknown> = {}) {
        return at(
            emscResponseSchema.parse({
                features: [
                    {
                        id: '20261017_0000107',
                        geometry: {
                            type: 'Point',
                            coordinates: [21.42, 42.0, -15],
                        },
                        properties: {
                            source_id: '2076106',
                            source_catalog: 'EMSC-RTS',
                            lastupdate: '2026-10-17T08:29:38.08296Z',
                            time: new Date(
                                Date.now() - 30 * 60_000,
                            ).toISOString(),
                            flynn_region: 'REPUBLIC OF NORTH MACEDONIA',
                            lat: 42.0,
                            lon: 21.42,
                            depth: -15,
                            evtype: 'ke',
                            auth: 'IGEO',
                            mag: 2.5,
                            magtype: 'ml',
                            unid: '20261017_0000107',
                            ...overrides,
                        },
                    },
                ],
            }).features,
            0,
        );
    }

    describe('fetch()', () => {
        it('adds a rolling start window to EMSC queries and treats 204 as empty', async () => {
            await withFrozenClock(frozenNow, async () => {
                const windowStrategy = new EmscStrategy(
                    'https://emsc.test/query?limit=10&format=json',
                    '* * * * *',
                    createFakeResolver(),
                );
                const urls: string[] = [];
                await withFetch(
                    async (input) => {
                        urls.push(String(input));
                        return jsonResponse({ features: [emscFeature] });
                    },
                    async () => {
                        const result = await windowStrategy.fetch();
                        assert.equal(result.length, 1);
                    },
                );

                const requested = new URL(present(at(urls, 0)));
                const start = new Date(
                    present(requested.searchParams.get('start')),
                );
                const windowMs = Date.now() - start.getTime();
                assert.ok(windowMs >= 23.9 * 60 * 60 * 1000);
                assert.ok(windowMs <= 24.1 * 60 * 60 * 1000);

                await withFetch(
                    async () => emptyResponse(204),
                    async () => {
                        assert.deepEqual(await windowStrategy.fetch(), []);
                    },
                );
            });
        });

        it('rejects non-OK responses', async () => {
            await withFetch(
                async () => textResponse('emsc error', 500),
                async () => {
                    await assert.rejects(
                        strategy.fetch(),
                        /Fetch failed with status code 500: emsc error/,
                    );
                },
            );
        });
    });

    describe('parse()', () => {
        it('keeps domestic earthquakes and marks fresh ones ongoing', async () => {
            await withFrozenClock(frozenNow, async () => {
                const occurredAt = new Date(Date.now() - 30 * 60_000);
                const [report] = await strategy.parse([
                    makeEmscFeature({ time: occurredAt.toISOString() }),
                ]);
                const parsed = present(report);
                assert.equal(parsed.externalId, '20261017_0000107');
                assert.equal(parsed.category, 'earthquake');
                assert.equal(parsed.municipalityCode, 'MK0080907');
                assert.equal(parsed.locationLabel, 'Карпош');
                assert.equal(parsed.status, 'ongoing');
                assert.equal(parsed.startsAt?.getTime(), occurredAt.getTime());
                assert.equal(parsed.endsAt?.getTime(), occurredAt.getTime());
                assert.equal(parsed.geom, 'SRID=4326;POINT(21.42 42)');
                assert.equal(parsed.rawPayload.depthKm, 15);
                assert.equal(parsed.rawPayload.magnitudeType, 'ML');
                assert.match(present(parsed.title), /Слаб земјотрес: Карпош/);
                assert.match(
                    present(parsed.description),
                    /слаб земјотрес со епицентар во подрачјето на Карпош, со јачина од 2\.5 степени \(ML\) и длабочина од 15 km/,
                );
            });
        });

        it('drops minor cross-border quakes and keeps felt ones without a municipality', async () => {
            await withFrozenClock(frozenNow, async () => {
                const minor = makeEmscFeature({
                    lon: 20.5,
                    lat: 40.8,
                    mag: 2.4,
                    flynn_region: 'GREECE',
                });
                assert.deepEqual(await strategy.parse([minor]), []);

                const occurredAt = new Date(Date.now() - 2 * 60 * 60_000);
                const felt = makeEmscFeature({
                    lon: 20.5,
                    lat: 40.8,
                    mag: 3.2,
                    flynn_region: 'GREECE',
                    time: occurredAt.toISOString(),
                });
                const [report] = await strategy.parse([felt]);
                const parsed = present(report);
                assert.equal(parsed.municipalityCode, null);
                assert.equal(
                    parsed.locationLabel,
                    'Грција (пограничен регион)',
                );
                assert.equal(parsed.status, 'ended');
                assert.equal(parsed.startsAt?.getTime(), occurredAt.getTime());
                assert.equal(parsed.geom, 'SRID=4326;POINT(20.5 40.8)');
                assert.match(
                    present(parsed.description),
                    /умерен земјотрес со епицентар во пограничниот регион на Грција/,
                );
            });
        });

        it('formats magnitude adjectives and border regions', async () => {
            await withFrozenClock(frozenNow, async () => {
                const adjectives = [
                    [2.5, 'слаб'],
                    [3.5, 'умерен'],
                    [4.2, 'посилен'],
                    [5.2, 'силен'],
                ] as const;
                for (const [mag, adjective] of adjectives) {
                    const [report] = await strategy.parse([
                        makeEmscFeature({
                            mag,
                            lon: mag < 3.0 ? 21.42 : 20.5,
                            lat: mag < 3.0 ? 42.0 : 40.8,
                            flynn_region: 'ALBANIA',
                        }),
                    ]);
                    assert.match(
                        present(present(report).description),
                        new RegExp(`${adjective} земјотрес`),
                    );
                }

                const regions = [
                    ['ALBANIA', 'Албанија (пограничен регион)'],
                    ['GREECE', 'Грција (пограничен регион)'],
                    ['BULGARIA', 'Бугарија (пограничен регион)'],
                    ['SERBIA', 'Србија (пограничен регион)'],
                    ['KOSOVO', 'Косово (пограничен регион)'],
                    ['ITALY', 'Граничен регион'],
                ] as const;
                for (const [flynnRegion, label] of regions) {
                    const [report] = await strategy.parse([
                        makeEmscFeature({
                            mag: 3.5,
                            lon: 20.5,
                            lat: 40.8,
                            flynn_region: flynnRegion,
                        }),
                    ]);
                    assert.equal(present(report).locationLabel, label);
                }
            });
        });

        it('keeps every domestic magnitude but drops cross-border quakes below 3.0', async () => {
            await withFrozenClock(frozenNow, async () => {
                // Domestic quakes have no magnitude floor: 1.9 and 2.0 are both kept
                for (const mag of [1.9, 2.0]) {
                    const [report] = await strategy.parse([
                        makeEmscFeature({ mag }),
                    ]);
                    assert.match(
                        present(present(report).title),
                        /Слаб земјотрес: Карпош/,
                    );
                }

                // Cross-border quakes: 2.9 is dropped, 3.0 is kept
                assert.deepEqual(
                    await strategy.parse([
                        makeEmscFeature({
                            mag: 2.9,
                            lon: 20.5,
                            lat: 40.8,
                            flynn_region: 'GREECE',
                        }),
                    ]),
                    [],
                );
                const [kept] = await strategy.parse([
                    makeEmscFeature({
                        mag: 3.0,
                        lon: 20.5,
                        lat: 40.8,
                        flynn_region: 'GREECE',
                    }),
                ]);
                assert.equal(
                    present(kept).locationLabel,
                    'Грција (пограничен регион)',
                );
            });
        });

        it('treats exactly 60 minutes as active and 60m + 1ms as ended', async () => {
            const frozenAt = new Date('2026-11-18T12:00:00.000Z');
            await withFrozenClock(frozenAt, async () => {
                const active = await strategy.parse([
                    makeEmscFeature({
                        time: new Date(
                            frozenAt.getTime() - 60 * 60_000,
                        ).toISOString(),
                    }),
                ]);
                assert.equal(present(at(active, 0)).status, 'ongoing');

                const stale = await strategy.parse([
                    makeEmscFeature({
                        time: new Date(
                            frozenAt.getTime() - 60 * 60_000 - 1,
                        ).toISOString(),
                    }),
                ]);
                assert.equal(present(at(stale, 0)).status, 'ended');
            });
        });
    });
});

describe('WorldFiresStrategy', () => {
    const strategy = new WorldFiresStrategy(
        'https://worldfires.test/api/v1/hotspots',
        '*/15 * * * *',
        resolver,
    );

    const makeHotspot = (
        overrides: Partial<WorldFiresHotspot> = {},
    ): WorldFiresHotspot => ({
        time_utc: new Date(Date.now() - 60_000),
        lat: 42,
        lon: 21.42,
        frp_mw: 12.34,
        satellite: ' NOAA-20 ',
        sensor: ' viirs ',
        ...overrides,
    });

    describe('fetch()', () => {
        it('fetches and validates the upstream payload', async () => {
            await withFetch(
                async () => jsonResponse({ data: [worldFiresHotspot] }),
                async () => {
                    const result = await strategy.fetch();
                    assert.ok(Array.isArray(result));
                },
            );
        });

        it('treats 204 as empty', async () => {
            await withFetch(
                async () => emptyResponse(204),
                async () => {
                    assert.deepEqual(await strategy.fetch(), []);
                },
            );
        });

        it('rejects non-OK responses', async () => {
            await withFetch(
                async () => textResponse('provider error', 500),
                async () => {
                    await assert.rejects(
                        strategy.fetch(),
                        /Fetch failed with status code 500: provider error/,
                    );
                },
            );
        });
    });

    describe('parse()', () => {
        it('maps domestic detections to ongoing reports with stable IDs and audit payloads', async () => {
            await withFrozenClock(frozenNow, async () => {
                const item = makeHotspot();
                const [report] = await strategy.parse([item]);
                const parsed = present(report);

                assert.equal(parsed.source, 'worldfires-hotspots');
                assert.equal(parsed.category, 'wildfire');
                assert.equal(parsed.municipalityCode, 'MK0080907');
                assert.equal(parsed.locationLabel, 'Карпош');
                assert.equal(parsed.status, 'ongoing');
                assert.equal(parsed.endsAt, null);
                assert.equal(parsed.startsAt, item.time_utc);
                assert.equal(parsed.geom, 'SRID=4326;POINT(21.42 42)');
                assert.match(
                    parsed.externalId,
                    /^worldfires-\d{8}T\d{4}Z-42\.000-21\.420-t2$/,
                );
                assert.equal(
                    at(await strategy.parse([item]), 0).externalId,
                    parsed.externalId,
                );
                assert.equal(parsed.title, 'Пожар: Карпош');
                assert.match(
                    present(parsed.description),
                    /Детектиран е пожар на отворен простор со умерен интензитет во подрачјето на Карпош\./,
                );
                assert.deepEqual(parsed.rawPayload, {
                    detectedAt: item.time_utc,
                    frpMw: 12.34,
                    hotspotCount: 1,
                    satellite: 'NOAA-20',
                    sensor: 'VIIRS',
                    coordinates: { lng: 21.42, lat: 42 },
                    hotspots: [{ lat: 42, lng: 21.42, frpMw: 12.34 }],
                });
                assert.equal('stateFeed' in strategy, false);
            });
        });

        it('transitively clusters bridge hotspots independent of input order', async () => {
            await withFrozenClock(frozenNow, async () => {
                const detectedAt = new Date(Date.now() - 60_000);
                const first = makeHotspot({
                    time_utc: detectedAt,
                    lat: 42,
                    lon: 21.42,
                    frp_mw: 12,
                });
                const second = makeHotspot({
                    time_utc: detectedAt,
                    lat: 42.024,
                    lon: 21.42,
                    frp_mw: 13,
                });
                const bridge = makeHotspot({
                    time_utc: detectedAt,
                    lat: 42.012,
                    lon: 21.42,
                    frp_mw: 14,
                });
                const forward = present(
                    at(await strategy.parse([first, second, bridge]), 0),
                );
                const reversed = present(
                    at(await strategy.parse([bridge, second, first]), 0),
                );

                assert.equal(forward.rawPayload.hotspotCount, 3);
                assert.equal(forward.rawPayload.frpMw, 39);
                assert.equal(forward.geom, 'SRID=4326;POINT(21.42 42.012)');
                assert.match(
                    present(forward.description),
                    /со умерен интензитет во подрачјето на Карпош \(3 жаришта\)\./,
                );
                assert.equal(reversed.externalId, forward.externalId);
                assert.equal(reversed.geom, forward.geom);
                assert.deepEqual(
                    reversed.rawPayload.hotspots,
                    forward.rawPayload.hotspots,
                );
                assert.deepEqual(forward.rawPayload.hotspots, [
                    { lat: 42, lng: 21.42, frpMw: 12 },
                    { lat: 42.012, lng: 21.42, frpMw: 14 },
                    { lat: 42.024, lng: 21.42, frpMw: 13 },
                ]);
            });
        });

        it('emits tier escalation reports across satellite passes without same-tier duplicates', async () => {
            await withFrozenClock(frozenNow, async () => {
                const t0 = new Date(Date.now() - 3 * 60 * 60_000);
                const t1 = new Date(t0.getTime() + 60 * 60_000);
                const t2 = new Date(t1.getTime() + 2 * 60 * 60_000);
                const ignition = makeHotspot({ time_utc: t0, frp_mw: 5 });
                const eruptionA = makeHotspot({
                    time_utc: t1,
                    lat: 42.005,
                    frp_mw: 30,
                });
                const eruptionB = makeHotspot({
                    time_utc: t1,
                    lat: 42.005,
                    frp_mw: 35,
                });
                const overpass = makeHotspot({
                    time_utc: t2,
                    lat: 42.005,
                    frp_mw: 55,
                });

                const initialRows = await strategy.parse([
                    ignition,
                    eruptionA,
                    eruptionB,
                ]);
                assert.equal(initialRows.length, 2);

                const lowerTier = present(at(initialRows, 0));
                assert.match(lowerTier.externalId, /-t1$/);
                assert.equal(lowerTier.status, 'ended');
                assert.equal(lowerTier.startsAt, t0);
                assert.equal(lowerTier.endsAt, t1);
                assert.equal(lowerTier.title, 'Пожар од помал обем: Карпош');

                const peakTier = present(at(initialRows, 1));
                assert.match(peakTier.externalId, /-t3$/);
                assert.equal(peakTier.status, 'ongoing');
                assert.equal(peakTier.startsAt, t0);
                assert.equal(peakTier.endsAt, null);
                assert.equal(peakTier.title, 'Силен пожар: Карпош');
                assert.equal(peakTier.rawPayload.hotspotCount, 2);
                assert.equal(peakTier.rawPayload.frpMw, 65);

                const allRows = await strategy.parse([
                    ignition,
                    eruptionA,
                    eruptionB,
                    overpass,
                ]);
                assert.equal(allRows.length, 2);
                assert.deepEqual(
                    allRows.map((row) => row.externalId),
                    initialRows.map((row) => row.externalId),
                );
            });
        });

        it('filters minor border detections and ends older strong detections', async () => {
            await withFrozenClock(frozenNow, async () => {
                const outsideResolver = new WorldFiresStrategy(
                    'https://worldfires.test/api/v1/hotspots',
                    '*/15 * * * *',
                    createFakeResolver({ coords: null }),
                );
                assert.deepEqual(
                    await outsideResolver.parse([
                        makeHotspot({ frp_mw: 9.99 }),
                    ]),
                    [],
                );

                const borderTime = new Date(Date.now() - 60_000);
                const [clusteredBorder] = await outsideResolver.parse([
                    makeHotspot({
                        time_utc: borderTime,
                        lat: 41.8,
                        lon: 20.5,
                        frp_mw: 6,
                    }),
                    makeHotspot({
                        time_utc: borderTime,
                        lat: 41.81,
                        lon: 20.5,
                        frp_mw: 5,
                    }),
                ]);
                assert.equal(present(clusteredBorder).rawPayload.frpMw, 11);
                assert.equal(
                    present(clusteredBorder).locationLabel,
                    'Пограничен регион',
                );
                assert.equal(
                    present(clusteredBorder).title,
                    'Пожар: Пограничен регион',
                );

                const oldDetection = makeHotspot({
                    time_utc: new Date(Date.now() - 8 * 60 * 60_000),
                    lat: 41.8,
                    lon: 20.5,
                    frp_mw: 50,
                });
                const [report] = await outsideResolver.parse([oldDetection]);
                const parsed = present(report);
                assert.equal(parsed.municipalityCode, null);
                assert.equal(parsed.locationLabel, 'Пограничен регион');
                assert.equal(parsed.status, 'ended');
                assert.equal(parsed.endsAt, oldDetection.time_utc);
                assert.equal(parsed.title, 'Силен пожар: Пограничен регион');
                assert.match(
                    present(parsed.description),
                    /во непосредна близина на државната граница со ризик од прекугранично проширување/,
                );
            });
        });

        it('formats four intensity tiers, normalizes sensor labels, and skips invalid coordinates or FRP', async () => {
            await withFrozenClock(frozenNow, async () => {
                const tiers = [
                    [9.99, 'Пожар од помал обем', /слаб интензитет/],
                    [10, 'Пожар', /умерен интензитет/],
                    [50, 'Силен пожар', /со висок интензитет/],
                    [
                        150,
                        'Пожар од големи размери',
                        /исклучително висок интензитет/,
                    ],
                ] as const;
                for (const [frpMw, title, prose] of tiers) {
                    const [report] = await strategy.parse([
                        makeHotspot({ frp_mw: frpMw }),
                    ]);
                    assert.equal(present(report).title, `${title}: Карпош`);
                    assert.match(present(present(report).description), prose);
                }

                const [normalizedSensor] = await strategy.parse([
                    makeHotspot({ satellite: 'VIIRS', sensor: 'viirs' }),
                ]);
                const sensorPayload = present(normalizedSensor).rawPayload;
                assert.equal(sensorPayload.satellite, 'VIIRS');
                assert.equal(sensorPayload.sensor, 'VIIRS');

                const invalid = await strategy.parse([
                    makeHotspot({ lat: Number.NaN }),
                    makeHotspot({ lon: Number.POSITIVE_INFINITY }),
                    makeHotspot({ frp_mw: Number.NaN }),
                    makeHotspot({ frp_mw: Number.POSITIVE_INFINITY }),
                    makeHotspot({ frp_mw: -1 }),
                ]);
                assert.deepEqual(invalid, []);

                const wireResult = worldFiresHotspotsResponseSchema.parse({
                    data: [
                        {
                            time_utc: '2026-11-08T12:08:00Z',
                            lat: '42',
                            lon: '21.42',
                            frp_mw: '9.5',
                            satellite: 'VIIRS',
                            sensor: 'VNP14IMG',
                        },
                    ],
                });
                assert.equal(at(wireResult.data, 0).frp_mw, 9.5);
            });
        });

        it('clusters within the 0.015-degree radius and splits beyond it', async () => {
            await withFrozenClock(frozenNow, async () => {
                const detectedAt = new Date(Date.now() - 60_000);
                const first = makeHotspot({
                    time_utc: detectedAt,
                    lat: 42,
                    lon: 21.42,
                    frp_mw: 12,
                });
                // 21.435 is the last longitude that satisfies |lon - 21.42| <= 0.015 in float arithmetic
                const edge = makeHotspot({
                    time_utc: detectedAt,
                    lat: 42,
                    lon: 21.435,
                    frp_mw: 13,
                });
                const merged = await strategy.parse([first, edge]);
                assert.equal(present(at(merged, 0)).rawPayload.hotspotCount, 2);

                const beyond = makeHotspot({
                    time_utc: detectedAt,
                    lat: 42,
                    lon: 21.4351,
                    frp_mw: 13,
                });
                const split = await strategy.parse([first, beyond]);
                assert.equal(split.length, 2);
                assert.equal(present(at(split, 0)).rawPayload.hotspotCount, 1);
                assert.equal(present(at(split, 1)).rawPayload.hotspotCount, 1);
            });
        });

        it('marks exactly 6h-old detections ongoing and 6h + 1ms ended', async () => {
            const frozenAt = new Date('2026-11-18T12:00:00.000Z');
            await withFrozenClock(frozenAt, async () => {
                const active = present(
                    at(
                        await strategy.parse([
                            makeHotspot({
                                time_utc: new Date(
                                    frozenAt.getTime() - 6 * 60 * 60_000,
                                ),
                            }),
                        ]),
                        0,
                    ),
                );
                assert.equal(active.status, 'ongoing');

                const stale = present(
                    at(
                        await strategy.parse([
                            makeHotspot({
                                time_utc: new Date(
                                    frozenAt.getTime() - 6 * 60 * 60_000 - 1,
                                ),
                            }),
                        ]),
                        0,
                    ),
                );
                assert.equal(stale.status, 'ended');
            });
        });
    });
});

describe('AmsmFuelStrategy', () => {
    const strategy = new AmsmFuelStrategy('http://amsm.test', '0 */2 * * *');

    describe('fetch()', () => {
        it('fetches and validates the upstream payload', async () => {
            await withFetch(
                async () => jsonResponse([fuel]),
                async () => {
                    const result = await strategy.fetch();
                    assert.ok(Array.isArray(result));
                },
            );
        });

        it('rejects non-OK responses', async () => {
            await withFetch(
                async () => textResponse('provider error', 500),
                async () => {
                    await assert.rejects(
                        strategy.fetch(),
                        /Fetch failed with status code 500: provider error/,
                    );
                },
            );
        });
    });

    describe('parse()', () => {
        it('hashes fuel prices deterministically and formats MKD/EUR prose', async () => {
            const raw = [
                {
                    id: 55,
                    date: '2026-10-25T00:00:00',
                    date_gmt: '2026-10-25T00:00:00',
                    modified: '2026-10-25T00:00:00',
                    modified_gmt: '2026-10-25T00:00:00',
                    slug: 'makedonija',
                    status: 'publish',
                    type: 'cena-goriva',
                    link: 'https://amsm.mk',
                    title: { rendered: 'Македонија' },
                    acf: {
                        gas_uid: 'mk',
                        gas_country: 'Македонија',
                        gas_currency: 'МКД',
                        petrol95: 78.5,
                        petrol98: 80.5,
                        diesel: 71,
                        petrol95eur: 1.276,
                        petrol98eur: 1.308,
                        dieseleur: 1.154,
                        gas_last_update: '2026-10-24',
                    },
                },
            ];

            const parsed = await strategy.parse(raw);
            assert.equal(parsed.length, 1);
            const event = at(parsed, 0);
            assert.equal(event.status, 'ongoing');
            assert.equal(event.endsAt, null);
            assert.match(
                present(event.description),
                /78.5 ден\/л \(1.28 EUR\/л\)/,
            );
            const repeated = await strategy.parse(raw);
            assert.equal(at(repeated, 0).externalId, event.externalId);

            const changedPrice = await strategy.parse([
                {
                    ...at(raw, 0),
                    acf: { ...at(raw, 0).acf, petrol95: 79 },
                },
            ]);
            assert.notEqual(at(changedPrice, 0).externalId, event.externalId);

            const beforeFallback = Date.now();
            const invalidUpdate = await strategy.parse([
                {
                    ...at(raw, 0),
                    acf: {
                        ...at(raw, 0).acf,
                        gas_last_update: 'not-a-date',
                        gas_country: '   ',
                    },
                },
            ]);
            const fallbackEvent = at(invalidUpdate, 0);
            assert.ok(fallbackEvent.startsAt instanceof Date);
            assert.ok(fallbackEvent.startsAt.getTime() >= beforeFallback);
            assert.equal(fallbackEvent.rawPayload.country, 'Македонија');
        });
    });
});

describe('NbrmRatesStrategy', () => {
    function makeRate(
        rBr: number,
        datum: string,
        oznaka: string,
        sreden: number,
        overrides: Partial<NbrmRateItem> = {},
    ): NbrmRateItem {
        return {
            rBr,
            datum,
            valuta: '1',
            oznaka,
            drzava: 'Германија',
            nomin: 1,
            sreden,
            nazivMak: 'ЕВРО',
            datum_f: `${datum.slice(8, 10)}.${datum.slice(5, 7)}.${datum.slice(0, 4)}`,
            ...overrides,
        };
    }

    describe('fetch()', () => {
        it('requests a 10-day window with dd.MM.yyyy dates and a JSON Accept header', async () => {
            const strategy = new NbrmRatesStrategy(
                'https://nbrm.test/kurs',
                '* * 8-18 * * *',
                () => new Date('2026-11-18T10:00:00Z'),
            );
            const requests: Array<{
                url: URL;
                headers: { Accept: string };
            }> = [];
            await withFetch(
                async (input, init) => {
                    requests.push({
                        url: new URL(String(input)),
                        headers: (init?.headers ?? {}) as {
                            Accept: string;
                        },
                    });
                    return jsonResponse([
                        makeRate(300, '2026-11-18T00:00:00', 'EUR', 61.5323),
                    ]);
                },
                async () => {
                    const result = await strategy.fetch();
                    assert.equal(result.length, 1);
                },
            );
            const requested = at(requests, 0);
            assert.equal(
                requested.url.searchParams.get('StartDate'),
                '08.11.2026',
            );
            assert.equal(
                requested.url.searchParams.get('EndDate'),
                '18.11.2026',
            );
            assert.equal(requested.url.searchParams.get('format'), 'json');
            assert.equal(requested.headers.Accept, 'application/json');
        });

        it('rejects HTML error pages', async () => {
            const strategy = new NbrmRatesStrategy(
                'https://nbrm.test/kurs',
                '* * 8-18 * * *',
                () => new Date('2026-11-18T10:00:00Z'),
            );
            await withFetch(
                async () =>
                    textResponse('<html>error</html>', 200, {
                        'Content-Type': 'text/html',
                    }),
                async () => {
                    await assert.rejects(
                        strategy.fetch(),
                        /Fetch returned an HTML error page/,
                    );
                },
            );
        });

        it('rejects non-OK responses', async () => {
            const strategy = new NbrmRatesStrategy(
                'https://nbrm.test/kurs',
                '* * 8-18 * * *',
                () => new Date('2026-11-18T10:00:00Z'),
            );
            await withFetch(
                async () => textResponse('server error', 500),
                async () => {
                    await assert.rejects(
                        strategy.fetch(),
                        /Fetch failed with status code 500: server error/,
                    );
                },
            );
        });
    });

    describe('parse()', () => {
        it('returns an empty list for an empty payload', async () => {
            const strategy = new NbrmRatesStrategy(
                'https://nbrm.test/kurs',
                '* * 8-18 * * *',
            );
            assert.deepEqual(await strategy.parse([]), []);
        });

        it('selects the active-day group, filters MAIN_CURRENCIES and anchors winter Skopje midnight', async () => {
            const strategy = new NbrmRatesStrategy(
                'https://nbrm.test/kurs',
                '* * 8-18 * * *',
                () => new Date('2026-11-18T10:00:00Z'),
            );
            const parsed = present(
                at(
                    await strategy.parse([
                        makeRate(300, '2026-11-17T00:00:00', 'EUR', 61.5323),
                        makeRate(300, '2026-11-18T00:00:00', 'EUR', 61.5323),
                        makeRate(300, '2026-11-18T00:00:00', 'USD', 56.7),
                        makeRate(300, '2026-11-18T00:00:00', 'GBP', 72.1),
                        makeRate(300, '2026-11-18T00:00:00', 'CHF', 64.9),
                        makeRate(300, '2026-11-18T00:00:00', 'AUD', 100.5),
                        makeRate(299, '2026-11-17T00:00:00', 'EUR', 61.4),
                    ]),
                    0,
                ),
            );
            assert.equal(parsed.externalId, 'nbrm-2026-300');
            assert.equal(parsed.status, 'ongoing');
            assert.equal(parsed.title, 'Тековна курсна листа');
            assert.equal(parsed.endsAt, null);
            // winter Europe/Skopje offset (+01:00): local midnight of the first day
            assert.equal(
                parsed.startsAt?.toISOString(),
                '2026-11-16T23:00:00.000Z',
            );
            assert.equal(parsed.rawPayload.rBr, 300);
            assert.deepEqual(parsed.rawPayload.dates, [
                '2026-11-17',
                '2026-11-18',
            ]);
            assert.match(
                present(parsed.description),
                /^Актуелни средни курсеви: EUR = 61,5323 ден\./,
            );
            assert.match(
                present(parsed.description),
                /USD = 56,7000 ден\., GBP = 72,1000 ден\., CHF = 64,9000 ден\.$/,
            );
            assert.doesNotMatch(present(parsed.description), /AUD/);
        });

        it('falls back to the latest group at or before today, preferring newer years and higher rBr', async () => {
            const strategy = new NbrmRatesStrategy(
                'https://nbrm.test/kurs',
                '* * 8-18 * * *',
                () => new Date('2026-01-05T10:00:00Z'),
            );
            const parsed = present(
                at(
                    await strategy.parse([
                        makeRate(260, '2025-12-31T00:00:00', 'EUR', 61.0),
                        makeRate(4, '2026-01-02T00:00:00', 'EUR', 61.5),
                        makeRate(5, '2026-01-02T00:00:00', 'EUR', 61.6),
                    ]),
                    0,
                ),
            );
            // the annual rBr counter reset in 2026, but the newer publication date wins the tie-break
            assert.equal(parsed.externalId, 'nbrm-2026-5');
            assert.equal(
                parsed.startsAt?.toISOString(),
                '2026-01-01T23:00:00.000Z',
            );
        });

        it('falls back to the first four rates when no main currency is present', async () => {
            const strategy = new NbrmRatesStrategy(
                'https://nbrm.test/kurs',
                '* * 8-18 * * *',
                () => new Date('2026-11-18T10:00:00Z'),
            );
            const parsed = present(
                at(
                    await strategy.parse([
                        makeRate(310, '2026-11-18T00:00:00', 'AUD', 100.5),
                        makeRate(310, '2026-11-18T00:00:00', 'CAD', 74.2),
                        makeRate(310, '2026-11-18T00:00:00', 'JPY', 0.4),
                        makeRate(310, '2026-11-18T00:00:00', 'RSD', 0.53),
                        makeRate(310, '2026-11-18T00:00:00', 'TRY', 1.7),
                    ]),
                    0,
                ),
            );
            assert.match(
                present(parsed.description),
                /^Актуелни средни курсеви: AUD = 100,5000 ден\., CAD = 74,2000 ден\., JPY = 0,4000 ден\., RSD = 0,5300 ден\.$/,
            );
            assert.doesNotMatch(present(parsed.description), /TRY/);
        });

        it('skips items with an impossible datum', async () => {
            const strategy = new NbrmRatesStrategy(
                'https://nbrm.test/kurs',
                '* * 8-18 * * *',
                () => new Date('2026-11-18T10:00:00Z'),
            );
            assert.deepEqual(
                await strategy.parse([
                    makeRate(1, '2026-02-30T00:00:00', 'EUR', 61.5),
                ]),
                [],
            );
        });

        it('anchors summer Europe/Skopje midnight at +02:00', async () => {
            const strategy = new NbrmRatesStrategy(
                'https://nbrm.test/kurs',
                '* * 8-18 * * *',
                () => new Date('2026-07-15T10:00:00Z'),
            );
            const parsed = present(
                at(
                    await strategy.parse([
                        makeRate(21, '2026-07-15T00:00:00', 'EUR', 61.6),
                    ]),
                    0,
                ),
            );
            assert.equal(
                parsed.startsAt?.toISOString(),
                '2026-07-14T22:00:00.000Z',
            );
        });
    });
});

describe('IodaEventsStrategy', () => {
    const fixedNow = new Date('2026-11-13T12:00:00Z');
    const timestamp = Math.floor(fixedNow.getTime() / 1000);
    const makeSeries = (
        entityType: string,
        entityCode: string,
        entityName: string,
        datasource: string,
        values: Array<number | null>,
    ) => ({
        entityType,
        entityCode,
        entityName,
        datasource,
        from: timestamp - (values.length - 1) * 300,
        until: timestamp,
        step: 300,
        values,
    });

    describe('fetch()', () => {
        it('issues the four fixed-window signal requests', async () => {
            const expectedUntil = Math.floor(fixedNow.getTime() / 1000);
            const expectedFrom = expectedUntil - 86_400;
            const series = {
                entityType: 'country',
                entityCode: 'MK',
                entityName: 'North Macedonia',
                datasource: 'bgp',
                from: expectedFrom,
                until: expectedUntil,
                step: 300,
                values: [100, 90],
            };
            const strategy = new IodaEventsStrategy(
                'https://ioda.test/v2',
                '*/10 * * * *',
                () => fixedNow,
            );
            const eventUrls: URL[] = [];
            await withFetch(
                async (input) => {
                    const url = new URL(String(input));
                    eventUrls.push(url);
                    return jsonResponse({ error: null, data: [[series]] });
                },
                async () => {
                    const result = await strategy.fetch();
                    assert.equal(result.countrySeries.length, 2);
                    assert.equal(result.asnSeries.length, 2);
                },
            );
            assert.equal(eventUrls.length, 4);
            assert.equal(
                at(eventUrls, 0).pathname,
                '/v2/signals/raw/country/MK',
            );
            assert.equal(
                at(eventUrls, 1).pathname,
                '/v2/signals/raw/country/MK',
            );
            assert.equal(at(eventUrls, 2).pathname, at(eventUrls, 3).pathname);
            assert.ok(
                at(eventUrls, 2).pathname.startsWith(
                    '/v2/signals/raw/asn/6821,16333',
                ),
            );
            for (const url of eventUrls) {
                assert.equal(
                    url.searchParams.get('from'),
                    String(expectedFrom),
                );
                assert.equal(
                    url.searchParams.get('until'),
                    String(expectedUntil),
                );
                assert.ok(
                    ['bgp', 'ping-slash24'].includes(
                        url.searchParams.get('datasource') ?? '',
                    ),
                );
            }
            assert.equal(eventUrls[0]?.searchParams.get('datasource'), 'bgp');
            assert.equal(
                eventUrls[1]?.searchParams.get('datasource'),
                'ping-slash24',
            );
        });
    });

    describe('parse()', () => {
        it('emits a natural-language national state event and handles trailing nulls', async () => {
            const strategy = new IodaEventsStrategy(
                'https://ioda.test/v2',
                '*/10 * * * *',
                () => fixedNow,
            );
            assert.equal(strategy.stateFeed, true);
            const rows = await strategy.parse({
                countrySeries: [
                    makeSeries('country', 'MK', 'North Macedonia', 'bgp', [
                        100,
                        100,
                        94,
                        null,
                    ]),
                    makeSeries(
                        'country',
                        'MK',
                        'North Macedonia',
                        'ping-slash24',
                        [100, 100, 100],
                    ),
                ],
                asnSeries: [],
            });
            const row = at(rows, 0);
            assert.equal(row.status, 'ongoing');
            assert.equal(row.endsAt, null);
            assert.equal(row.rawPayload.status, 'degraded');
            assert.equal(row.title, 'Отежнат национален интернет сообраќај');
            assert.match(row.title, /интернет/);
            assert.match(
                present(row.description),
                /Намалена достапност на националната интернет мрежа во Македонија \(95,8% од капацитетот\)\./,
            );
            assert.doesNotMatch(
                present(row.description),
                /BGP|ping-slash24|\d{2}\.\d{2}\./i,
            );
            const recovered = at(
                await strategy.parse({
                    countrySeries: [
                        makeSeries(
                            'country',
                            'MK',
                            'North Macedonia',
                            'bgp',
                            [100, 50, 100],
                        ),
                    ],
                    asnSeries: [],
                }),
                0,
            );
            assert.equal(recovered.rawPayload.status, 'normal');
            assert.equal(recovered.status, 'omitted');
            assert.equal(recovered.title, 'Состојба на интернет мрежата');
            assert.ok(recovered.externalId.endsWith(`-normal-${timestamp}`));
            const previousDayRecovery = at(
                await strategy.parse({
                    countrySeries: [
                        {
                            ...makeSeries(
                                'country',
                                'MK',
                                'North Macedonia',
                                'bgp',
                                [100, 50, 100],
                            ),
                            from: timestamp - 13 * 3600 - 900,
                        },
                    ],
                    asnSeries: [],
                }),
                0,
            );
            assert.equal(
                previousDayRecovery.externalId,
                'ioda-mk-2026-11-13-normal',
            );
            const boundaryRecovery = at(
                await strategy.parse({
                    countrySeries: [
                        {
                            ...makeSeries(
                                'country',
                                'MK',
                                'North Macedonia',
                                'bgp',
                                [100, 50, 100],
                            ),
                            from: timestamp - 13 * 3600 - 600,
                        },
                    ],
                    asnSeries: [],
                }),
                0,
            );
            assert.equal(
                boundaryRecovery.externalId,
                `ioda-mk-2026-11-13-normal-${timestamp - 13 * 3600}`,
            );
        });

        it('aggregates A1 multi-ASN metrics and returns no row without a positive baseline', async () => {
            const strategy = new IodaEventsStrategy(
                'https://ioda.test/v2',
                '* * * * *',
                () => fixedNow,
            );
            const a1Signals = ['16333', '43612', '57374', '43494'].map((code) =>
                makeSeries('asn', code, 'A1', 'bgp', [10, 10, 0]),
            );
            const rows = await strategy.parse({
                countrySeries: [
                    makeSeries('country', 'MK', 'MK', 'bgp', [100, 100, 0]),
                ],
                asnSeries: [
                    ...a1Signals,
                    makeSeries('asn', '6821', 'Telekom', 'bgp', [10, 10, 0]),
                ],
            });
            const row = at(rows, 0);
            assert.equal(row.rawPayload.operators[1]?.bgp?.baseline, 40);
            assert.equal(row.rawPayload.operators[1]?.status, 'outage');
            assert.equal(row.rawPayload.status, 'outage');
            assert.equal(row.title, 'Национален прекин на интернет мрежата');
            assert.match(
                present(row.description),
                /Национален прекин на интернет сообраќајот во Македонија \(0% достапност\), погодени оператори: Македонски Телеком \(0%\), А1 Македонија \(0%\)\./,
            );
            assert.deepEqual(row.rawPayload.affectedOperators, [
                'Македонски Телеком',
                'А1 Македонија',
            ]);
            assert.equal(
                await strategy
                    .parse({
                        countrySeries: [
                            makeSeries('country', 'MK', 'MK', 'bgp', [0, 0, 0]),
                        ],
                        asnSeries: [],
                    })
                    .then((result) => result.length),
                0,
            );
        });

        it('pins the BGP/ping baseline floor at 10 and clamps availability to 0–100%', async () => {
            const strategy = new IodaEventsStrategy(
                'https://ioda.test/v2',
                '* * * * *',
                () => fixedNow,
            );

            // baseline 10 with a 90% ratio classifies the country as degraded
            const degraded = at(
                await strategy.parse({
                    countrySeries: [
                        makeSeries('country', 'MK', 'MK', 'bgp', [10, 10, 9]),
                    ],
                    asnSeries: [],
                }),
                0,
            );
            assert.equal(degraded.rawPayload.status, 'degraded');
            assert.equal(degraded.rawPayload.availabilityPct, 90);

            // baseline 9.9 falls below the floor, so the same 90% ratio stays normal
            const normal = at(
                await strategy.parse({
                    countrySeries: [
                        makeSeries(
                            'country',
                            'MK',
                            'MK',
                            'bgp',
                            [9.9, 9.9, 8.91],
                        ),
                    ],
                    asnSeries: [],
                }),
                0,
            );
            assert.equal(normal.rawPayload.status, 'normal');
            assert.equal(normal.rawPayload.availabilityPct, 90);

            // a ratio above 100% clamps to 100
            const above = at(
                await strategy.parse({
                    countrySeries: [
                        makeSeries(
                            'country',
                            'MK',
                            'MK',
                            'ping-slash24',
                            [100, 100, 150],
                        ),
                    ],
                    asnSeries: [],
                }),
                0,
            );
            assert.equal(above.rawPayload.availabilityPct, 100);

            // a zero ratio floors availability at 0
            const below = at(
                await strategy.parse({
                    countrySeries: [
                        makeSeries('country', 'MK', 'MK', 'bgp', [100, 100, 0]),
                    ],
                    asnSeries: [],
                }),
                0,
            );
            assert.equal(below.rawPayload.status, 'outage');
            assert.equal(below.rawPayload.availabilityPct, 0);
        });
    });
});

describe('IodaReportsStrategy', () => {
    const fixedNow = new Date('2026-11-13T12:00:00Z');
    const timestamp = Math.floor(fixedNow.getTime() / 1000);
    const names: Record<string, string> = {
        Štip: 'MK0021100',
        Струмица: 'MK0041000',
        Кичево: 'MK0030700',
        Tetovo: 'MK0060900',
    };
    const regions: Record<string, Array<{ code: string; nameMk: string }>> = {
        MK002: [{ code: 'MK0021100', nameMk: 'Штип' }],
        MK004: [{ code: 'MK0041000', nameMk: 'Струмица' }],
        MK003: [{ code: 'MK0030700', nameMk: 'Кичево' }],
        MK006: [{ code: 'MK0060900', nameMk: 'Тетово' }],
    };
    const resolver = createFakeResolver({
        text: (text) => (text ? (names[text] ?? null) : null),
        region: (regionCode) => (regionCode ? (regions[regionCode] ?? []) : []),
    });
    const makeRegion = (
        code: string,
        name: string,
        datasource: string,
        values: Array<number | null>,
    ) => ({
        entityType: 'region',
        entityCode: code,
        entityName: name,
        datasource,
        from: timestamp - (values.length - 1) * 300,
        until: timestamp,
        step: 300,
        values,
    });

    describe('fetch()', () => {
        it('issues the two fixed-window region requests', async () => {
            const expectedUntil = Math.floor(fixedNow.getTime() / 1000);
            const expectedFrom = expectedUntil - 86_400;
            const series = {
                entityType: 'country',
                entityCode: 'MK',
                entityName: 'North Macedonia',
                datasource: 'bgp',
                from: expectedFrom,
                until: expectedUntil,
                step: 300,
                values: [100, 90],
            };
            const strategy = new IodaReportsStrategy(
                'https://ioda.test/v2',
                '*/10 * * * *',
                resolver,
                () => fixedNow,
            );
            const reportUrls: URL[] = [];
            await withFetch(
                async (input) => {
                    reportUrls.push(new URL(String(input)));
                    return jsonResponse({
                        error: null,
                        data: [
                            [
                                {
                                    ...series,
                                    entityType: 'region',
                                    entityCode: '2602',
                                },
                            ],
                        ],
                    });
                },
                async () => {
                    const result = await strategy.fetch();
                    assert.equal(result.length, 2);
                },
            );
            assert.equal(reportUrls.length, 2);
            assert.ok(
                reportUrls.every((url) =>
                    url.pathname.includes('/signals/raw/region/'),
                ),
            );
            assert.ok(reportUrls.every((url) => url.pathname.includes('2586')));
            assert.ok(
                reportUrls.every(
                    (url) =>
                        url.searchParams.get('from') === String(expectedFrom),
                ),
            );
        });

        it('rejects envelope errors', async () => {
            const strategy = new IodaReportsStrategy(
                'https://ioda.test/v2',
                '*/10 * * * *',
                resolver,
                () => fixedNow,
            );
            await withFetch(
                async () =>
                    jsonResponse({ error: 'invalid parameters', data: null }),
                async () => {
                    await assert.rejects(
                        strategy.fetch(),
                        /IODA request failed: invalid parameters/,
                    );
                },
            );
        });
    });

    describe('parse()', () => {
        it('resolves regions and stores normal versus degraded state-feed reports', async () => {
            const strategy = new IodaReportsStrategy(
                'https://ioda.test/v2',
                '*/10 * * * *',
                resolver,
                () => fixedNow,
            );
            assert.equal(strategy.stateFeed, true);
            const rows = await strategy.parse([
                makeRegion('2602', 'Štip', 'bgp', [100, 50, 100]),
                makeRegion('2654', 'Southeastern', 'bgp', [100, 100, 50]),
                makeRegion('2643', 'Drugovo', 'bgp', [10, 10, 10]),
                makeRegion('2648', 'Tetovo', 'bgp', [100, 100, 85]),
                makeRegion('2592', 'Skopje', 'bgp', [20, 20, 20]),
                makeRegion('4870', 'Unknown', 'bgp', [20, 20, 20]),
            ]);
            assert.equal(rows.length, 4);
            assert.equal(at(rows, 0).municipalityCode, 'MK0021100');
            assert.equal(at(rows, 0).locationLabel, 'Штип');
            assert.equal(at(rows, 0).status, 'omitted');
            assert.equal(at(rows, 0).title, 'Интернет мрежа: Штип');
            assert.equal(
                present(at(rows, 0).description),
                'Интернет сообраќајот во Штип се одвива нормално (100% достапност).',
            );
            assert.equal(at(rows, 0).externalId, 'MK0021100-2026-11-13-normal');
            assert.equal(at(rows, 1).municipalityCode, 'MK0041000');
            assert.equal(at(rows, 1).status, 'ongoing');
            assert.equal(at(rows, 1).rawPayload.status, 'outage');
            assert.equal(at(rows, 1).title, 'Прекин на интернет: Струмица');
            assert.equal(
                present(at(rows, 1).description),
                'Прекин во интернет сообраќајот во Струмица (50% достапност).',
            );
            assert.equal(at(rows, 1).externalId, 'MK0041000-2026-11-13-outage');
            assert.equal(at(rows, 2).municipalityCode, 'MK0030700');
            assert.equal(at(rows, 2).locationLabel, 'Кичево');
            assert.equal(at(rows, 3).municipalityCode, 'MK0060900');
            assert.equal(at(rows, 3).rawPayload.status, 'degraded');
            assert.equal(at(rows, 3).status, 'ongoing');
            assert.equal(
                at(rows, 3).title,
                'Отежнат интернет сообраќај: Тетово',
            );
            assert.equal(
                present(at(rows, 3).description),
                'Намалена достапност на интернет мрежата во Тетово (85% од вообичаениот капацитет).',
            );
            assert.equal(
                at(rows, 3).externalId,
                'MK0060900-2026-11-13-degraded',
            );
            assert.doesNotMatch(
                present(at(rows, 1).description),
                /BGP|ping-slash24|\d{2}\.\d{2}\./i,
            );
        });

        it('skips regions that cannot be resolved or have no positive baseline', async () => {
            const strategy = new IodaReportsStrategy(
                'https://ioda.test/v2',
                '* * * * *',
                resolver,
                () => fixedNow,
            );
            assert.deepEqual(
                await strategy.parse([
                    makeRegion('2602', 'Štip', 'bgp', [0, 0, 0]),
                    makeRegion('9999', 'Atlantis', 'bgp', [10, 10, 10]),
                ]),
                [],
            );
        });

        it('pins the BGP floor at 5 and the ping floor at 10', async () => {
            const strategy = new IodaReportsStrategy(
                'https://ioda.test/v2',
                '* * * * *',
                resolver,
                () => fixedNow,
            );

            // BGP baseline 5 with an 89% ratio degrades the region
            const bgpDegraded = at(
                await strategy.parse([
                    makeRegion('2602', 'Štip', 'bgp', [5, 5, 4.45]),
                ]),
                0,
            );
            assert.equal(bgpDegraded.rawPayload.status, 'degraded');

            // BGP baseline 4.9 falls below the floor, so the same ratio stays normal
            const bgpNormal = at(
                await strategy.parse([
                    makeRegion('2602', 'Štip', 'bgp', [4.9, 4.9, 4.361]),
                ]),
                0,
            );
            assert.equal(bgpNormal.rawPayload.status, 'normal');

            // ping baseline 10 with a 70% ratio degrades the region
            const pingDegraded = at(
                await strategy.parse([
                    makeRegion('2602', 'Štip', 'ping-slash24', [10, 10, 7]),
                ]),
                0,
            );
            assert.equal(pingDegraded.rawPayload.status, 'degraded');

            // ping baseline 9.9 falls below the floor, so the same ratio stays normal
            const pingNormal = at(
                await strategy.parse([
                    makeRegion(
                        '2602',
                        'Štip',
                        'ping-slash24',
                        [9.9, 9.9, 6.93],
                    ),
                ]),
                0,
            );
            assert.equal(pingNormal.rawPayload.status, 'normal');
        });
    });
});
