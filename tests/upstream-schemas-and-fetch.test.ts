import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { amsmFuelResponseSchema } from '../src/core/validation/amsm-fuel.js';
import { evnResponseSchema } from '../src/core/validation/evn.js';
import { meteoalarmResponseSchema } from '../src/core/validation/meteoalarm.js';
import {
    moeppMeasurementsResponseSchema,
    moeppStationsResponseSchema,
} from '../src/core/validation/moepp.js';
import { sensorCommunityResponseSchema } from '../src/core/validation/sensor-community.js';
import { vodovodSkopjeResponseSchema } from '../src/core/validation/vodovod-skopje.js';
import type { MunicipalityResolver } from '../src/modules/scraping/resolver.js';
import { AmsmFuelStrategy } from '../src/modules/scraping/strategies/amsm-fuel.strategy.js';
import { EvnStrategy } from '../src/modules/scraping/strategies/evn.strategy.js';
import { MeteoalarmStrategy } from '../src/modules/scraping/strategies/meteoalarm.strategy.js';
import { MoeppStrategy } from '../src/modules/scraping/strategies/moepp.strategy.js';
import { SensorCommunityStrategy } from '../src/modules/scraping/strategies/sensor-community.strategy.js';
import { VodovodSkopjeStrategy } from '../src/modules/scraping/strategies/vodovod-skopje.strategy.js';
import { at, present } from './test-utils.js';

const index = { code: '04', color: '#f00', name: 'Лош', nameEN: 'Poor' };
const station = {
    id: 7,
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
};
const measurement = {
    stationID: 7,
    stationName: 'Лисиче',
    stationNameEN: 'Lisice',
    fromTime: '2026-10-25T08:00:00',
    toTime: '2026-10-25T09:00:00',
    aQ_Value: 88,
    aQ_Index: index,
    cO_Value: null,
    cO_Index: null,
    nO2_Value: null,
    nO2_Index: null,
    o3_Value: null,
    o3_Index: null,
    pM25_Value: 42,
    pM25_Index: index,
    pM10_Value: 88,
    pM10_Index: index,
    sO2_Value: null,
    sO2_Index: null,
};
const fuel = {
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
        petrol95: '78.5',
        petrol98: 80.5,
        diesel: 71,
        petrol95eur: 1.276,
        petrol98eur: 1.308,
        dieseleur: 1.154,
        gas_last_update: '2026-10-24',
    },
};
const alert = {
    uuid: 'u-1',
    alert: {
        identifier: 'alert-1',
        sender: 'uhmr@example.test',
        sent: '2026-10-25T08:00:00Z',
        status: 'Actual',
        msgType: 'Alert',
        info: [
            {
                language: 'en-GB',
                event: 'Thunderstorm',
                onset: '2026-10-25T08:00:00Z',
                expires: '2026-10-25T12:00:00Z',
                parameter: [],
                area: [{ areaDesc: 'Skopje', geocode: [] }],
            },
        ],
    },
};
const sensor = {
    id: 1,
    timestamp: '2026-10-25 10:15:00',
    sensor: {
        id: 1,
        sensor_type: { id: 14, name: 'SDS011', manufacturer: 'Nova' },
    },
    location: {
        id: 1,
        latitude: '42.0',
        longitude: '21.42',
        altitude: '250',
        country: 'MK',
        indoor: 0,
    },
    sensordatavalues: [
        { value_type: 'P1', value: '60' },
        { value_type: 'P2', value: 30 },
    ],
};

function fakeResolver(): MunicipalityResolver {
    return {
        resolveText: () => null,
        resolveCoords: async () => null,
        resolveRegion: () => [],
    } as unknown as MunicipalityResolver;
}

async function withFetch<T>(
    handler: typeof fetch,
    run: () => Promise<T>,
): Promise<T> {
    const original = globalThis.fetch;
    globalThis.fetch = handler;
    try {
        return await run();
    } finally {
        globalThis.fetch = original;
    }
}

function jsonResponse(value: unknown): Response {
    return new Response(JSON.stringify(value), { status: 200 });
}

describe('Upstream response schemas', () => {
    it('validates and transforms source wire formats', () => {
        const evn = evnResponseSchema.parse([
            {
                prekinID: '1',
                kecId: 1,
                tipPrekin: 'Test',
                nasMesto: 'A',
                adresa: 'B',
                pocetok: '2026-10-25T00:00:00Z',
                kraj: '2026-10-25T01:00:00Z',
                napNivo: 'НН',
            },
        ]);
        assert.ok(at(evn, 0).pocetok instanceof Date);
        const vodovod = vodovodSkopjeResponseSchema.parse({
            features: [
                {
                    attributes: {
                        idINT: 2,
                        Opstina: 'Карпош',
                        Ulica: 'Тест',
                        vidDefektName: 'Дефект',
                        status: 0,
                        acceptanceDate: 1_761_000_000_000,
                        statusVreme: null,
                        datumZatvorenaVoda: 0,
                    },
                    geometry: null,
                },
            ],
        });
        assert.equal(
            at(vodovod.features, 0).attributes.acceptanceDate instanceof Date,
            true,
        );
        assert.equal(
            at(vodovod.features, 0).attributes.datumZatvorenaVoda,
            null,
        );

        assert.equal(at(moeppStationsResponseSchema.parse([station]), 0).id, 7);
        assert.equal(
            moeppMeasurementsResponseSchema.parse([measurement]).length,
            1,
        );
        assert.equal(
            at(amsmFuelResponseSchema.parse([fuel]), 0).acf.petrol95,
            78.5,
        );
        assert.equal(
            meteoalarmResponseSchema.parse({ warnings: [alert] }).warnings
                .length,
            1,
        );
        const sensorResult = at(
            sensorCommunityResponseSchema.parse([sensor]),
            0,
        );
        assert.equal(sensorResult.location.latitude, 42);
        assert.equal(at(sensorResult.sensordatavalues, 0).value, 60);

        assert.equal(
            evnResponseSchema.safeParse([{ prekinID: 'incomplete' }]).success,
            false,
        );
        assert.equal(
            amsmFuelResponseSchema.safeParse([
                { ...fuel, acf: { ...fuel.acf, diesel: 0 } },
            ]).success,
            false,
        );
    });
});

describe('Strategy fetch adapters', () => {
    it('fetches and validates EVN, Vodovod, Meteoalarm, Sensor.Community and AMSM payloads', async () => {
        const strategies = [
            [
                new EvnStrategy(
                    'https://evn.test',
                    '* * * * *',
                    fakeResolver(),
                ),
                [
                    {
                        prekinID: '1',
                        kecId: 1,
                        tipPrekin: 'Test',
                        nasMesto: 'A',
                        adresa: 'B',
                        pocetok: '2026-10-25T00:00:00Z',
                        kraj: '2026-10-25T01:00:00Z',
                        napNivo: 'НН',
                    },
                ],
            ],
            [
                new VodovodSkopjeStrategy(
                    'https://vodovod.test',
                    '* * * * *',
                    fakeResolver(),
                ),
                {
                    features: [
                        {
                            attributes: {
                                idINT: 2,
                                Opstina: 'Карпош',
                                Ulica: 'Тест',
                                vidDefektName: 'Дефект',
                                status: 0,
                                acceptanceDate: 1_761_000_000_000,
                            },
                            geometry: null,
                        },
                    ],
                },
            ],
            [
                new MeteoalarmStrategy(
                    'https://meteo.test',
                    '* * * * *',
                    fakeResolver(),
                ),
                { warnings: [alert] },
            ],
            [
                new SensorCommunityStrategy(
                    'https://sensor.test',
                    '* * * * *',
                    fakeResolver(),
                ),
                [sensor],
            ],
            [new AmsmFuelStrategy('https://amsm.test', '* * * * *'), [fuel]],
        ] as const;

        for (const [strategy, payload] of strategies) {
            await withFetch(
                async () => jsonResponse(payload),
                async () => {
                    const result = await strategy.fetch();
                    assert.ok(Array.isArray(result));
                },
            );
        }
    });

    it('fetches MOEPP stations then posts their IDs to retrieve measurements', async () => {
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
                    fakeResolver(),
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

    it('rejects non-OK upstream responses', async () => {
        const strategy = new EvnStrategy(
            'https://evn.test',
            '* * * * *',
            fakeResolver(),
        );
        await withFetch(
            async () => new Response('upstream down', { status: 503 }),
            async () => {
                await assert.rejects(
                    strategy.fetch(),
                    /Fetch failed with status code 503: upstream down/,
                );
            },
        );
    });

    it('rejects non-OK responses from every remaining fetch adapter', async () => {
        const simpleStrategies = [
            new VodovodSkopjeStrategy(
                'https://vodovod.test',
                '* * * * *',
                fakeResolver(),
            ),
            new MeteoalarmStrategy(
                'https://meteo.test',
                '* * * * *',
                fakeResolver(),
            ),
            new SensorCommunityStrategy(
                'https://sensor.test',
                '* * * * *',
                fakeResolver(),
            ),
            new AmsmFuelStrategy('https://amsm.test', '* * * * *'),
        ];
        for (const strategy of simpleStrategies) {
            await withFetch(
                async () => new Response('provider error', { status: 500 }),
                async () => {
                    await assert.rejects(
                        strategy.fetch(),
                        /Fetch failed with status code 500: provider error/,
                    );
                },
            );
        }

        await withFetch(
            async (_input, init) =>
                init?.method === 'POST'
                    ? new Response('measurement error', { status: 500 })
                    : jsonResponse([station]),
            async () => {
                await assert.rejects(
                    new MoeppStrategy(
                        'https://moepp.test/api',
                        '* * * * *',
                        fakeResolver(),
                    ).fetch(),
                    /Fetch failed with status code 500: measurement error/,
                );
            },
        );
    });
});
