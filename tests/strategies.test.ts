import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { emscResponseSchema } from '../src/core/validation/emsc.js';
import { vodovodSkopjeResponseSchema } from '../src/core/validation/vodovod-skopje.js';
import type { MunicipalityResolver } from '../src/modules/scraping/resolver.js';
import { AmsmFuelStrategy } from '../src/modules/scraping/strategies/amsm-fuel.strategy.js';
import { EmscStrategy } from '../src/modules/scraping/strategies/emsc.strategy.js';
import { EvnStrategy } from '../src/modules/scraping/strategies/evn.strategy.js';
import { MeteoalarmStrategy } from '../src/modules/scraping/strategies/meteoalarm.strategy.js';
import { MoeppStrategy } from '../src/modules/scraping/strategies/moepp.strategy.js';
import { SensorCommunityStrategy } from '../src/modules/scraping/strategies/sensor-community.strategy.js';
import { VodovodKumanovoStrategy } from '../src/modules/scraping/strategies/vodovod-kumanovo.strategy.js';
import { VodovodPrilepStrategy } from '../src/modules/scraping/strategies/vodovod-prilep.strategy.js';
import { VodovodSkopjeStrategy } from '../src/modules/scraping/strategies/vodovod-skopje.strategy.js';
import { at, present } from './test-utils.js';

function createFakeResolver(
    overrides: {
        resolveText?: (text?: string | null) => string | null;
        resolveCoords?: (
            lng?: number | null,
            lat?: number | null,
        ) => Promise<{ code: string; name: string } | null>;
        resolveRegion?: (
            regionCode?: string | null,
        ) => Array<{ code: string; nameMk: string }>;
    } = {},
): MunicipalityResolver {
    return {
        resolveText:
            overrides.resolveText ??
            ((text?: string | null) => {
                if (!text) return null;
                const upper = text.toUpperCase();
                if (upper.includes('АЕРОДРОМ')) return 'MK0080901';
                if (upper.includes('КАРПОШ')) return 'MK0080907';
                if (upper.includes('ГАЗИ БАБА')) return 'MK0080904';
                if (upper.includes('МАВРОВО')) return 'MK0060401';
                return null;
            }),
        resolveCoords:
            overrides.resolveCoords ??
            (async (lng?: number | null, lat?: number | null) => {
                if (!lng || !lat) return null;
                if (lng > 21.3 && lng < 21.6 && lat > 41.9 && lat < 42.1) {
                    return { code: 'MK0080907', name: 'Карпош' };
                }
                return null;
            }),
        resolveRegion:
            overrides.resolveRegion ??
            ((regionCode?: string | null) => {
                if (regionCode === 'MK008') {
                    return [
                        { code: 'MK0080901', nameMk: 'Аеродром' },
                        { code: 'MK0080904', nameMk: 'Гази Баба' },
                    ];
                }
                return [];
            }),
    } as unknown as MunicipalityResolver;
}

function makeVodovodFeature(
    attributes: Record<string, unknown> = {},
    geometry: { x: number; y: number } | null = null,
) {
    return at(
        vodovodSkopjeResponseSchema.parse({
            features: [
                {
                    attributes: {
                        idINT: 10,
                        Opstina: 'КАРПОШ',
                        Ulica: 'Партизанска',
                        vidDefektName: 'Дефект на мрежа',
                        status: 0,
                        acceptanceDate: Date.now() - 60_000,
                        ...attributes,
                    },
                    geometry,
                },
            ],
        }).features,
        0,
    );
}

describe('Scraping Strategies', () => {
    const resolver = createFakeResolver();

    describe('EvnStrategy', () => {
        const strategy = new EvnStrategy(
            'http://evn.test',
            '*/30 * * * *',
            resolver,
        );

        it('formats locations, prose descriptions, externalId hash, and statuses', async () => {
            const now = Date.now();
            const raw = [
                {
                    prekinID: '100',
                    kecId: 1,
                    tipPrekin: 'Планирани прекини',
                    nasMesto: 'АЕРОДРОМ-СКОПЈЕ-ЈАНЕ САНДАНСКИ (123)',
                    adresa: 'бул. Јане Сандански,ул. Островска.',
                    pocetok: new Date(now - 3600_000),
                    kraj: new Date(now + 3600_000),
                    napNivo: 'НН',
                },
                {
                    prekinID: '101',
                    kecId: 2,
                    tipPrekin: 'Планирани прекини',
                    nasMesto: 'МАВРОВО-РОСТУШЕ',
                    adresa: 'Корисниците во с. Ростуше ќе останат без напојување',
                    pocetok: new Date(now + 3600_000),
                    kraj: new Date(now + 7200_000),
                    napNivo: 'СН',
                },
            ];

            const parsed = await strategy.parse(raw);
            assert.equal(parsed.length, 2);

            const first = at(parsed, 0);
            assert.equal(first.externalId.length, 32);
            assert.equal(first.locationLabel, 'Јане Сандански, Аеродром');
            assert.equal(first.municipalityCode, 'MK0080901');
            assert.equal(first.status, 'ongoing');
            assert.equal(
                first.description,
                'Без електрична енергија ќе останат корисниците во: бул. Јане Сандански, ул. Островска.',
            );

            const second = at(parsed, 1);
            assert.equal(second.locationLabel, 'Маврово и Ростуша');
            assert.equal(second.municipalityCode, 'MK0060401');
            assert.equal(second.status, 'scheduled');
            assert.equal(
                second.description,
                'Корисниците во с. Ростуше ќе останат без напојување.',
            );

            const stable = await strategy.parse(raw);
            assert.equal(at(stable, 0).externalId, first.externalId);
            const changed = await strategy.parse([
                { ...at(raw, 0), kraj: new Date(now + 2 * 3600_000) },
            ]);
            assert.notEqual(at(changed, 0).externalId, first.externalId);
        });

        it('handles malformed date ranges, ended items, simple locations and place fallback', async () => {
            const now = Date.now();
            const placeFallbackCalls: string[] = [];
            const fallbackStrategy = new EvnStrategy(
                'http://evn.test',
                '*/30 * * * *',
                createFakeResolver({
                    resolveText: (text) => {
                        placeFallbackCalls.push(text ?? '');
                        return text === 'НЕПОЗНАТО-СКОПЈЕ' ? 'MK0080901' : null;
                    },
                }),
            );
            const parsed = await fallbackStrategy.parse([
                {
                    prekinID: '200',
                    kecId: 1,
                    tipPrekin: 'Test',
                    nasMesto: 'БИТОЛА',
                    adresa: 'ул. Тест',
                    pocetok: new Date(now - 3_600_000),
                    kraj: new Date(now - 1_800_000),
                    napNivo: 'НН',
                },
                {
                    prekinID: '201',
                    kecId: 1,
                    tipPrekin: 'Test',
                    nasMesto: 'ВЕЛЕС-ВЕЛЕС',
                    adresa: 'ул. Тест',
                    pocetok: new Date(now - 1_000),
                    kraj: new Date(now - 2_000),
                    napNivo: 'НН',
                },
                {
                    prekinID: '202',
                    kecId: 1,
                    tipPrekin: 'Test',
                    nasMesto: 'НЕПОЗНАТО-СКОПЈЕ',
                    adresa: 'ул. Тест',
                    pocetok: new Date(now - 1_000),
                    kraj: new Date(now + 1_000),
                    napNivo: 'НН',
                },
            ]);
            assert.equal(at(parsed, 0).locationLabel, 'Битола');
            assert.equal(at(parsed, 0).status, 'ended');
            assert.equal(at(parsed, 1).locationLabel, 'Велес');
            assert.equal(at(parsed, 1).endsAt, null);
            assert.equal(at(parsed, 1).status, 'ongoing');
            assert.equal(at(parsed, 2).municipalityCode, 'MK0080901');
            assert.equal(
                placeFallbackCalls.at(-1),
                'НЕПОЗНАТО-СКОПЈЕ',
                'uses the raw place after the formatted location misses',
            );
        });
    });

    describe('VodovodSkopjeStrategy', () => {
        const strategy = new VodovodSkopjeStrategy(
            'http://vodovod.test',
            '*/30 * * * *',
            resolver,
        );

        it('filters РАЗ test entries, handles ESRI dates, sewage unblocking, and urgency', async () => {
            const now = Date.now();
            const raw = [
                {
                    attributes: {
                        idINT: 1,
                        Opstina: 'КАРПОШ',
                        Ulica: 'Партизанска',
                        vidDefektName: 'Дефект',
                        status: 0,
                        acceptanceDate: now - 1000,
                        title: 'РАЗ',
                    },
                    geometry: { x: 21.42, y: 42.0 },
                },
                {
                    attributes: {
                        idINT: 2,
                        archiveNumber: 'A-1',
                        Opstina: 'КАРПОШ',
                        Ulica: '“Партизанска”',
                        adresaBrojDefekt: '15',
                        lokacija: 'до маркет',
                        vidDefektId: 1,
                        vidDefektName: 'затната канализација',
                        vidIntervencijaId: 2,
                        vidIntervencijaName:
                            'Канализација - цистерна за отпушување',
                        defectInfo: 'прелива',
                        itnostString: 'итно',
                        izvesteniPrekin: null,
                        status: 0,
                        statusVreme: null,
                        acceptanceDate: now - 3600_000,
                        datumZatvorenaVoda: null,
                        datumPustenaVoda: null,
                        zatvorenaVodaTip: null,
                        prekinStrujaHidrofor: 1,
                        naprevenUvid: 1,
                        title: 'Редовен',
                    },
                    geometry: { x: 21.42, y: 42.0 },
                },
                {
                    attributes: {
                        idINT: 3,
                        Opstina: 'АЕРОДРОМ',
                        Ulica: 'Булевар АВНОЈ',
                        vidDefektName: 'дефект на мрежа',
                        status: 2,
                        acceptanceDate: now - 7200_000,
                        statusVreme: now - 1800_000,
                        datumZatvorenaVoda: null,
                        datumPustenaVoda: null,
                    },
                    geometry: null,
                },
            ];

            const features = vodovodSkopjeResponseSchema.parse({
                features: raw,
            }).features;
            const parsed = await strategy.parse(features);
            assert.equal(parsed.length, 2);

            const openSewer = at(parsed, 0);
            assert.equal(openSewer.externalId, '2');
            assert.equal(openSewer.status, 'ongoing');
            assert.equal(openSewer.locationLabel, 'Партизанска 15, Карпош');
            assert.equal(openSewer.geom, 'SRID=4326;POINT(21.42 42)');
            assert.match(
                present(openSewer.description),
                /цистерна за отпушување со итен приоритет/,
            );

            const closedWater = at(parsed, 1);
            assert.equal(closedWater.externalId, '3');
            assert.equal(closedWater.status, 'ended');
            assert.ok(closedWater.endsAt instanceof Date);
        });

        it('covers cancellation, future starts, end-date guards, prose branches and coordinate fallback', async () => {
            const now = Date.now();
            const dateCases = await strategy.parse([
                makeVodovodFeature({
                    idINT: 20,
                    status: 1,
                    statusVreme: now - 10_000,
                }),
                makeVodovodFeature({
                    idINT: 21,
                    acceptanceDate: now + 60_000,
                }),
                makeVodovodFeature({
                    idINT: 22,
                    datumZatvorenaVoda: now + 60_000,
                    datumPustenaVoda: now,
                }),
            ]);
            assert.equal(at(dateCases, 0).status, 'ended');
            assert.equal(at(dateCases, 1).status, 'scheduled');
            assert.equal(at(dateCases, 2).endsAt, null);
            assert.equal(at(dateCases, 2).status, 'scheduled');

            const proseCases = await strategy.parse([
                makeVodovodFeature({
                    idINT: 23,
                    vidDefektName: 'Пукната цевка',
                    vidIntervencijaName: 'Поправка',
                }),
                makeVodovodFeature({
                    idINT: 24,
                    vidDefektName: 'затната мрежа',
                    vidIntervencijaName: 'интервенција отпушување',
                }),
            ]);
            assert.match(
                present(at(proseCases, 0).description),
                /Пријавен е проблем \(пукната цевка\)/,
            );
            assert.match(
                present(at(proseCases, 0).description),
                /Екипите вршат интервенција на водоводната мрежа/,
            );
            assert.match(
                present(at(proseCases, 1).description),
                /интервенција на канализациската мрежа/,
            );

            const coordinateStrategy = new VodovodSkopjeStrategy(
                'http://vodovod.test',
                '*/30 * * * *',
                createFakeResolver({
                    resolveText: () => null,
                    resolveCoords: async () => ({
                        code: 'MK0080907',
                        name: 'Карпош',
                    }),
                }),
            );
            const coordinateReport = at(
                await coordinateStrategy.parse([
                    makeVodovodFeature(
                        { idINT: 25, Opstina: 'НЕПОЗНАТО' },
                        { x: 21.42, y: 42 },
                    ),
                ]),
                0,
            );
            assert.equal(coordinateReport.municipalityCode, 'MK0080907');
        });
    });

    describe('MoeppStrategy', () => {
        const strategy = new MoeppStrategy(
            'http://moepp.test',
            '*/30 * * * *',
            resolver,
        );

        it('marks poor indices ongoing, non-poor indices omitted, with stateFeed enabled', async () => {
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
                    resolveCoords: async () => null,
                    resolveText: (text) => {
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

    describe('MeteoalarmStrategy', () => {
        const strategy = new MeteoalarmStrategy(
            'http://meteoalarm.test',
            '*/15 * * * *',
            resolver,
        );

        it('ignores ?????? strings, maps awareness params, and fans out NUTS3 regions via resolveRegion', async () => {
            const now = Date.now();
            const raw = [
                {
                    uuid: 'u-1',
                    alert: {
                        identifier: 'ALERT-1',
                        sender: 'uhmr@meteo.gov.mk',
                        sent: new Date(now - 600_000),
                        status: 'Actual',
                        msgType: 'Alert',
                        info: [
                            {
                                language: 'en-GB',
                                category: ['Met'],
                                event: 'Thunderstorm',
                                responseType: ['Monitor'],
                                onset: new Date(now - 300_000),
                                expires: new Date(now + 3600_000),
                                parameter: [
                                    {
                                        valueName: 'awareness_level',
                                        value: '2; yellow; Moderate',
                                    },
                                    {
                                        valueName: 'awareness_type',
                                        value: '3; Thunderstorm',
                                    },
                                ],
                                area: [
                                    {
                                        areaDesc: 'Skopje region',
                                        geocode: [
                                            {
                                                valueName: 'NUTS3',
                                                value: 'MK008',
                                            },
                                        ],
                                    },
                                ],
                            },
                            {
                                language: 'mk-MKD',
                                category: ['Met'],
                                event: 'Thunderstorm',
                                responseType: ['Monitor'],
                                headline: '??????',
                                description: '??????',
                                parameter: [],
                                area: [
                                    { areaDesc: 'Skopje region', geocode: [] },
                                ],
                            },
                        ],
                    },
                },
            ];

            const parsed = await strategy.parse(raw);
            // MK008 fans out into Аеродром (MK0080901) and Гази Баба (MK0080904)
            assert.equal(parsed.length, 2);

            const firstAlert = at(parsed, 0);
            assert.equal(firstAlert.externalId, 'ALERT-1-MK0080901');
            assert.equal(firstAlert.locationLabel, 'Аеродром');
            assert.equal(firstAlert.title, 'Грмежи и невреме: Аеродром');
            assert.equal(firstAlert.status, 'ongoing');
            assert.doesNotMatch(present(firstAlert.description), /\?\?\?/);

            const secondAlert = at(parsed, 1);
            assert.equal(secondAlert.externalId, 'ALERT-1-MK0080904');
            assert.equal(secondAlert.locationLabel, 'Гази Баба');
            assert.equal(secondAlert.title, 'Грмежи и невреме: Гази Баба');

            const ignored = await strategy.parse([
                {
                    ...at(raw, 0),
                    alert: { ...at(raw, 0).alert, status: 'Test' },
                },
            ]);
            assert.deepEqual(ignored, []);

            const scheduled = await strategy.parse([
                {
                    ...at(raw, 0),
                    alert: {
                        ...at(raw, 0).alert,
                        info: [
                            {
                                ...at(at(raw, 0).alert.info, 0),
                                onset: new Date(Date.now() + 3600_000),
                                expires: new Date(Date.now() + 7200_000),
                            },
                        ],
                    },
                },
            ]);
            assert.equal(at(scheduled, 0).status, 'scheduled');

            const canceled = await strategy.parse([
                {
                    ...at(raw, 0),
                    alert: { ...at(raw, 0).alert, msgType: 'Cancel' },
                },
            ]);
            assert.equal(at(canceled, 0).status, 'ended');

            const expired = await strategy.parse([
                {
                    ...at(raw, 0),
                    alert: {
                        ...at(raw, 0).alert,
                        info: [
                            {
                                ...at(at(raw, 0).alert.info, 0),
                                onset: new Date(Date.now() - 7200_000),
                                expires: new Date(Date.now() - 3600_000),
                            },
                        ],
                    },
                },
            ]);
            assert.equal(at(expired, 0).status, 'ended');

            const green = await strategy.parse([
                {
                    ...at(raw, 0),
                    alert: {
                        ...at(raw, 0).alert,
                        info: [
                            {
                                ...at(at(raw, 0).alert.info, 0),
                                parameter: [
                                    {
                                        valueName: 'awareness_level',
                                        value: '1; green; Green',
                                    },
                                ],
                            },
                        ],
                    },
                },
            ]);
            assert.equal(at(green, 0).status, 'omitted');

            const fallbackInfo = at(at(raw, 0).alert.info, 1);
            const infoFallback = await strategy.parse([
                {
                    ...at(raw, 0),
                    alert: {
                        ...at(raw, 0).alert,
                        info: [fallbackInfo],
                    },
                },
            ]);
            assert.equal(
                at(infoFallback, 0).startsAt?.getTime(),
                now - 600_000,
            );
            assert.match(
                at(infoFallback, 0).externalId,
                /^ALERT-1-Skopje region$/,
            );

            const validMacedonianText = await strategy.parse([
                {
                    ...at(raw, 0),
                    alert: {
                        ...at(raw, 0).alert,
                        info: [
                            at(at(raw, 0).alert.info, 0),
                            {
                                ...fallbackInfo,
                                description: 'Внимавајте на силен ветер.',
                            },
                        ],
                    },
                },
            ]);
            assert.match(
                present(at(validMacedonianText, 0).description),
                /Внимавајте на силен ветер\./,
            );

            const validTextWithoutPeriod = await strategy.parse([
                {
                    ...at(raw, 0),
                    alert: {
                        ...at(raw, 0).alert,
                        info: [
                            at(at(raw, 0).alert.info, 0),
                            {
                                ...fallbackInfo,
                                description: 'Внимавајте на силен ветер',
                            },
                        ],
                    },
                },
            ]);
            assert.match(
                present(at(validTextWithoutPeriod, 0).description),
                /Внимавајте на силен ветер\./,
            );

            const baseEnglishInfo = at(at(raw, 0).alert.info, 0);
            const { onset: _onset, ...withoutOnset } = baseEnglishInfo;
            const effectiveTime = new Date(Date.now() + 3600_000);
            const effectiveFallback = await strategy.parse([
                {
                    ...at(raw, 0),
                    alert: {
                        ...at(raw, 0).alert,
                        info: [
                            {
                                ...withoutOnset,
                                effective: effectiveTime,
                                expires: new Date(effectiveTime.getTime() - 1),
                            },
                        ],
                    },
                },
            ]);
            assert.equal(
                at(effectiveFallback, 0).startsAt?.getTime(),
                effectiveTime.getTime(),
            );
            assert.equal(at(effectiveFallback, 0).endsAt, null);

            for (const [levelCode, expectedColor] of [
                ['3', 'портокалово'],
                ['4', 'црвено'],
            ] as const) {
                const coloredAlert = await strategy.parse([
                    {
                        ...at(raw, 0),
                        alert: {
                            ...at(raw, 0).alert,
                            info: [
                                {
                                    ...baseEnglishInfo,
                                    parameter: [
                                        {
                                            valueName: 'awareness_level',
                                            value: `${levelCode}; color; label`,
                                        },
                                        {
                                            valueName: 'awareness_type',
                                            value: '4; Fog',
                                        },
                                    ],
                                },
                            ],
                        },
                    },
                ]);
                assert.ok(at(coloredAlert, 0).title.startsWith('Густа магла'));
                assert.match(
                    present(at(coloredAlert, 0).description),
                    new RegExp(expectedColor),
                );
            }

            const fallbackTranslations = [
                ['Strong wind', 'Силен ветер'],
                ['Heavy rain', 'Обилни врнежи од дожд'],
                ['Snow and ice', 'Снег и голомразица'],
                ['Dense fog', 'Густа магла'],
                ['High temperature', 'Високи температури'],
                ['Low temperature', 'Ниски температури'],
                ['Flood', 'Опасност од поплави'],
                ['Forest fire', 'Опасност од шумски пожари'],
                ['Other hazard', 'Метеоролошко предупредување'],
            ] as const;
            for (const [eventName, expectedTitle] of fallbackTranslations) {
                const translated = await strategy.parse([
                    {
                        ...at(raw, 0),
                        alert: {
                            ...at(raw, 0).alert,
                            info: [
                                {
                                    ...at(at(raw, 0).alert.info, 0),
                                    event: eventName,
                                    parameter: [],
                                },
                            ],
                        },
                    },
                ]);
                assert.ok(at(translated, 0).title.startsWith(expectedTitle));
            }
        });
    });

    describe('SensorCommunityStrategy', () => {
        const strategy = new SensorCommunityStrategy(
            'http://sensor.test',
            '*/15 * * * *',
            resolver,
        );

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
                    ...(pm25 === undefined
                        ? []
                        : [{ value_type: 'P2', value: pm25 }]),
                ],
            });
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
                createFakeResolver({ resolveCoords: async () => null }),
            );
            assert.deepEqual(await unmapped.parse([makePacket(60)]), []);
        });
    });

    describe('EmscStrategy', () => {
        const strategy = new EmscStrategy(
            'https://emsc.test/query?minmag=2.0',
            '*/10 * * * *',
            createFakeResolver(),
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

        it('keeps domestic earthquakes and marks fresh ones ongoing', async () => {
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

        it('drops minor cross-border quakes and keeps felt ones without a municipality', async () => {
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
            assert.equal(parsed.locationLabel, 'Грција (пограничен регион)');
            assert.equal(parsed.status, 'ended');
            assert.equal(parsed.startsAt?.getTime(), occurredAt.getTime());
            assert.equal(parsed.geom, 'SRID=4326;POINT(20.5 40.8)');
            assert.match(
                present(parsed.description),
                /умерен земјотрес со епицентар во пограничниот регион на Грција/,
            );
        });

        it('formats magnitude adjectives and border regions', async () => {
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

    describe('AmsmFuelStrategy', () => {
        const strategy = new AmsmFuelStrategy(
            'http://amsm.test',
            '0 */2 * * *',
        );

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
            assert.match(present(fallbackEvent.description), /во Македонија/);
        });
    });

    describe('VodovodKumanovoStrategy', () => {
        const strategy = new VodovodKumanovoStrategy(
            'https://vodovod-kumanovo.test/wp-json/wp/v2/posts',
            '*/30 * * * *',
        );

        const formatSkopjeDate = (date: Date) =>
            new Intl.DateTimeFormat('en-CA', {
                timeZone: 'Europe/Skopje',
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
            }).format(date);

        it('parses daily <li> defect and intervention items, deduplicates within post, and resolves Kumanovo', async () => {
            const todaySkopje = formatSkopjeDate(new Date());
            const raw = [
                {
                    id: 8015,
                    date: `${todaySkopje}T07:54:14`,
                    link: 'https://vodovod-kumanovo.com.mk/post-8015/',
                    title: {
                        rendered:
                            'Дефекти и интервенции на водоводна мрежа на ден 22.10.2026год.',
                    },
                    content: {
                        rendered: [
                            '<ul>',
                            '<li>ул. 114 бр. 6, нас. Карпош &#8211; дефект на водоводна мрежа.</li>',
                            '<li>ул. 114 бр. 6, нас. Карпош – дефект на водоводна мрежа</li>',
                            '<li>Б.С. Лук-оил (Романовски пат &#8211; муслимански гробишта ) &#8211; замена на овален затворач во водомерна шахта.</li>',
                            '<li>ул. Козјачка, нас. Вера Которка ( индустриска зона) -времено стопирање на приклучок поради изведба на ископ.</li>',
                            '</ul>',
                        ].join('\n'),
                    },
                },
                {
                    id: 8010,
                    date: '2026-10-19T07:58:11',
                    link: 'https://vodovod-kumanovo.com.mk/post-8010/',
                    title: {
                        rendered:
                            'Дефекти и интервенции на водоводна мрежа на ден 19.10.2026год.',
                    },
                    content: {
                        rendered:
                            '<ul><li>ул. Среќко Пужаљка &#8211; дефект на водоводна мрежа.</li></ul>',
                    },
                },
            ];

            const parsed = await strategy.parse(raw);
            assert.equal(parsed.length, 4);

            const first = at(parsed, 0);
            assert.equal(first.externalId.length, 32);
            assert.equal(first.source, 'vodovod-kumanovo');
            assert.equal(first.category, 'water');
            assert.equal(first.municipalityCode, 'MK0070300');
            assert.equal(
                first.locationLabel,
                'ул. 114 бр. 6, нас. Карпош, Куманово',
            );
            assert.equal(first.title, 'Дефект: ул. 114 бр. 6, нас. Карпош');
            assert.equal(
                first.description,
                'ул. 114 бр. 6, нас. Карпош – дефект на водоводна мрежа.',
            );
            assert.equal(first.status, 'ongoing');
            assert.equal(first.rawPayload.postId, 8015);
            assert.equal(first.rawPayload.items.length, 3);

            const second = at(parsed, 1);
            assert.equal(
                second.title,
                'Интервенција: Б.С. Лук-оил (Романовски пат – муслимански гробишта)',
            );
            assert.equal(
                second.locationLabel,
                'Б.С. Лук-оил (Романовски пат – муслимански гробишта), Куманово',
            );

            const third = at(parsed, 2);
            assert.equal(
                third.title,
                'Интервенција: ул. Козјачка, нас. Вера Которка (индустриска зона)',
            );
            assert.equal(
                third.description,
                'ул. Козјачка, нас. Вера Которка (индустриска зона) – времено стопирање на приклучок поради изведба на ископ.',
            );

            const historical = at(parsed, 3);
            assert.equal(historical.status, 'ended');
            assert.equal(
                historical.startsAt?.toISOString(),
                '2026-10-18T22:00:00.000Z',
            );
            assert.equal(
                historical.endsAt?.toISOString(),
                '2026-10-19T21:59:59.999Z',
            );
        });

        it('handles <p> fallback, inline/city-wide locations, scheduled dates, and invalid posts', async () => {
            const tomorrowSkopje = formatSkopjeDate(
                new Date(Date.now() + 2 * 24 * 3600_000),
            );
            const raw = [
                {
                    id: 7907,
                    date: `${tomorrowSkopje}T07:42:42`,
                    link: 'https://vodovod-kumanovo.com.mk/post-7907/',
                    title: { rendered: 'Најава' },
                    content: {
                        rendered: [
                            '<p>&#8211; Испитување на водоводна мрежа на ул. Мавровска бр. 1 по пријава за намален притисок.</p>',
                            '<p>чистење на градски украсни фонтани</p>',
                            '<p>бул. 3 МУБ</p>',
                            '<p>ул. Народна Револуција, Куманово &#8211; дефект на водоводна мрежа.</p>',
                            '<p>&nbsp;</p>',
                        ].join('\n'),
                    },
                },
                {
                    id: 7908,
                    date: 'invalid-date',
                    link: 'https://vodovod-kumanovo.com.mk/post-7908/',
                    title: { rendered: 'Невалиден датум' },
                    content: {
                        rendered: '<ul><li>ул. Тест – дефект.</li></ul>',
                    },
                },
                {
                    id: 7909,
                    date: '2026-11-06T09:00:00',
                    link: 'https://vodovod-kumanovo.com.mk/post-7909/',
                    title: { rendered: 'Празно' },
                    content: {
                        rendered: '<p>&nbsp;</p>',
                    },
                },
            ];

            const parsed = await strategy.parse(raw);
            assert.equal(parsed.length, 4);

            const inlineLoc = at(parsed, 0);
            assert.equal(inlineLoc.status, 'scheduled');
            assert.equal(inlineLoc.title, 'Дефект: ул. Мавровска бр. 1');
            assert.equal(
                inlineLoc.locationLabel,
                'ул. Мавровска бр. 1, Куманово',
            );
            assert.equal(
                inlineLoc.description,
                'Испитување на водоводна мрежа на ул. Мавровска бр. 1 по пријава за намален притисок.',
            );

            const cityWide = at(parsed, 1);
            assert.equal(cityWide.title, 'Интервенција: Куманово');
            assert.equal(cityWide.locationLabel, 'Куманово');
            assert.equal(
                cityWide.description,
                'Чистење на градски украсни фонтани.',
            );

            const streetOnly = at(parsed, 2);
            assert.equal(streetOnly.title, 'Дефект: бул. 3 МУБ');
            assert.equal(streetOnly.locationLabel, 'бул. 3 МУБ, Куманово');
            assert.equal(streetOnly.description, 'Бул. 3 МУБ.');

            const withCitySuffix = at(parsed, 3);
            assert.equal(
                withCitySuffix.locationLabel,
                'ул. Народна Револуција, Куманово',
            );
        });
    });

    describe('VodovodPrilepStrategy', () => {
        const strategy = new VodovodPrilepStrategy(
            'https://vodovod-prilep.test/wp-json/wp/v2/posts',
            '*/30 * * * *',
        );

        const formatSkopjeDate = (date: Date) =>
            new Intl.DateTimeFormat('en-CA', {
                timeZone: 'Europe/Skopje',
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
            }).format(date);

        it('stores normal daily supply as omitted, parses street outage time windows, and alerts abnormal supply', async () => {
            const todaySkopje = formatSkopjeDate(new Date());
            const raw = [
                {
                    id: 7357,
                    date: `${todaySkopje}T08:49:45`,
                    link: 'https://vodovod-prilep.mk/post-7357/',
                    title: {
                        rendered: 'ВОДОСНАБДУВАЊЕТО НА ОПШТИНА ПРИЛЕП',
                    },
                    excerpt: {
                        rendered:
                            '<p>Водоснабдувањето на ден <strong>05.11.2026</strong> [&hellip;]</p>',
                    },
                    content: {
                        rendered: [
                            '<p>Водоснабдувањето на ден <strong>05.11.2026</strong> (четврток) ќе биде нормално со здравствено исправна вода за пиење.<br>Вкупната произведена количина на вода <strong>234л/с</strong>, од кои <strong>206л/с</strong> од Студенчица,0л/с од бунари и <strong>28л/с</strong> од сопствени извори.</p>',
                            '<h2 class="wp-block-heading">Прекин во водоснабдувањето заради санација на дефекти и приклучоци во периодот од 08 до 14 часот ќе има на следните улици и делови од Општина Прилеп:</h2>',
                            '<h2 class="wp-block-heading">– ул. Лазо Филипоски</h2>',
                            '<h2 class="wp-block-heading">– ул. Лазо Филипоски.</h2>',
                            '<h2 class="wp-block-heading">– н.м. Мажучиште</h2>',
                        ].join('\n'),
                    },
                },
                {
                    id: 3508,
                    date: `${todaySkopje}T07:38:44`,
                    link: 'https://vodovod-prilep.mk/post-3508/',
                    title: {
                        rendered: 'ВОДОСНАБДУВАЊЕТО НА ОПШТИНА ПРИЛЕП',
                    },
                    content: {
                        rendered:
                            '<p>Водоснабдувањето на ден 23.11.2021 ќе биде нормално со здравствено исправна вода за пиење.<br>Вкупната произведена количина на вода е 247л/с, од кои 217л/с од Студенчица, 0л/с од бунари и 30л/с сопствени извори. Водоснабдувањето ќе биде нарушено во високата зона на град Прилеп.<br><br>Прекин во водоснабдувањето заради санација на дефекти во периодот од 08:30 до 15:30 часот ќе има на следните улици и делови од Општина Прилеп:<br>– Марксова</p>',
                    },
                },
            ];

            const parsed = await strategy.parse(raw);
            assert.equal(parsed.length, 5);

            const normalSupply = at(parsed, 0);
            assert.equal(normalSupply.source, 'vodovod-prilep');
            assert.equal(normalSupply.category, 'water');
            assert.equal(normalSupply.municipalityCode, 'MK0050800');
            assert.equal(normalSupply.locationLabel, 'Прилеп');
            assert.equal(normalSupply.title, 'Водоснабдување: Прилеп');
            assert.equal(normalSupply.status, 'omitted');
            assert.deepEqual(normalSupply.rawPayload.supply, {
                totalLs: 234,
                studenchicaLs: 206,
                wellsLs: 0,
                springsLs: 28,
            });
            assert.match(
                present(normalSupply.description),
                /Студенчица, 0л\/с од бунари и 28л\/с од сопствени извори\.$/,
            );

            const firstStreet = at(parsed, 1);
            assert.equal(
                firstStreet.title,
                'Прекин во водоснабдувањето: ул. Лазо Филипоски',
            );
            assert.equal(
                firstStreet.locationLabel,
                'ул. Лазо Филипоски, Прилеп',
            );
            assert.equal(
                firstStreet.description,
                'Прекин во водоснабдувањето заради санација на дефекти и приклучоци во периодот од 08:00 до 14:00 часот на ул. Лазо Филипоски.',
            );
            assert.equal(firstStreet.rawPayload.recordType, 'outage');
            assert.equal(
                present(firstStreet.endsAt).getTime() -
                    present(firstStreet.startsAt).getTime(),
                6 * 3600_000,
            );

            const disruptedSupply = at(parsed, 3);
            assert.equal(
                disruptedSupply.title,
                'Нарушено водоснабдување: Прилеп',
            );
            assert.equal(disruptedSupply.status, 'ongoing');

            const customWindowStreet = at(parsed, 4);
            assert.match(
                present(customWindowStreet.description),
                /во периодот од 08:30 до 15:30 часот на Марксова\.$/,
            );
            assert.equal(
                present(customWindowStreet.endsAt).getTime() -
                    present(customWindowStreet.startsAt).getTime(),
                7 * 3600_000,
            );
        });

        it('parses standalone emergency notices, ignores HR/PR posts, and marks historical outages ended', async () => {
            const todaySkopje = formatSkopjeDate(new Date());
            const raw = [
                {
                    id: 7126,
                    date: `${todaySkopje}T12:40:15`,
                    link: 'https://vodovod-prilep.mk/post-7126/',
                    title: {
                        rendered: 'Известување за жителите на н.м. Ореовец',
                    },
                    content: {
                        rendered:
                            '<p>Им соопштуваме на корисниците на вода за пиење од н.м. Оревоец да не ја користат истата, поради проблеми со дистрибуцијата на електрична енергија во системот за хлорирање.</p>',
                    },
                },
                {
                    id: 6846,
                    date: `${todaySkopje}T10:02:38`,
                    link: 'https://vodovod-prilep.mk/post-6846/',
                    title: {
                        rendered:
                            'ЈАВЕН ПОВИК ЗА ПРИЈАВУВАЊЕ ЧЛЕН ВО НАДЗОРЕН ОДБОР',
                    },
                    content: {
                        rendered:
                            '<p>Советот на Општина Прилеп објавува јавен повик за член во Надзорен Одбор.</p>',
                    },
                },
                {
                    id: 7337,
                    date: '2026-10-22T07:26:31',
                    link: 'https://vodovod-prilep.mk/post-7337/',
                    title: { rendered: '' },
                    excerpt: {
                        rendered:
                            '<p>Водоснабдувањето на ден 22.10.2026 ќе биде нормално со здравствено исправна вода за пиење.</p>',
                    },
                    content: {
                        rendered: '',
                    },
                },
                {
                    id: 7000,
                    date: 'invalid-date',
                    link: 'https://vodovod-prilep.mk/post-7000/',
                    title: { rendered: 'Invalid' },
                    content: { rendered: '<p>Тест</p>' },
                },
            ];

            const parsed = await strategy.parse(raw);
            assert.equal(parsed.length, 2);

            const notice = at(parsed, 0);
            assert.equal(notice.status, 'ongoing');
            assert.equal(notice.title, 'Вонредно известување: н.м. Ореовец');
            assert.equal(notice.locationLabel, 'н.м. Ореовец, Прилеп');
            assert.equal(notice.rawPayload.recordType, 'notice');

            const pastSupply = at(parsed, 1);
            assert.equal(pastSupply.status, 'ended');
            assert.equal(
                pastSupply.startsAt?.toISOString(),
                '2026-10-21T22:00:00.000Z',
            );
            assert.equal(
                pastSupply.endsAt?.toISOString(),
                '2026-10-22T21:59:59.999Z',
            );
        });
    });
});
