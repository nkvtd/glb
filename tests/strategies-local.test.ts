import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { vodovodSkopjeResponseSchema } from '../src/core/validation/vodovod-skopje.js';
import { EvnStrategy } from '../src/modules/scraping/strategies/evn.strategy.js';
import { MeteoalarmStrategy } from '../src/modules/scraping/strategies/meteoalarm.strategy.js';
import { OpstinaDebrcaStrategy } from '../src/modules/scraping/strategies/opstina-debrca.strategy.js';
import { OpstinaVelesStrategy } from '../src/modules/scraping/strategies/opstina-veles.strategy.js';
import { VodovodKumanovoStrategy } from '../src/modules/scraping/strategies/vodovod-kumanovo.strategy.js';
import { VodovodPrilepStrategy } from '../src/modules/scraping/strategies/vodovod-prilep.strategy.js';
import { VodovodSkopjeStrategy } from '../src/modules/scraping/strategies/vodovod-skopje.strategy.js';
import { at, present } from './util/assertions.js';
import { localCalendarDate, withFrozenClock } from './util/clock.js';
import {
    createFakeResolver,
    createStandardFakeResolver,
} from './util/fakes.js';
import { jsonResponse, textResponse, withFetch } from './util/fetch-mock.js';
import {
    alert,
    debrcaPost,
    kumanovoPost,
    prilepPost,
    velesPost,
} from './util/fixtures.js';

const resolver = createStandardFakeResolver();

// Wall-clock-dependent strategies are frozen at a fixed mid-day instant so
// "today" in Europe/Skopje never drifts across a midnight boundary mid-test.
const frozenNow = new Date('2026-11-18T12:00:00.000Z');

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

describe('EvnStrategy', () => {
    const strategy = new EvnStrategy(
        'http://evn.test',
        '*/30 * * * *',
        resolver,
    );

    describe('fetch()', () => {
        it('fetches and validates the upstream payload', async () => {
            await withFetch(
                async () =>
                    jsonResponse([
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
                    ]),
                async () => {
                    const result = await strategy.fetch();
                    assert.ok(Array.isArray(result));
                },
            );
        });

        it('rejects non-OK upstream responses', async () => {
            await withFetch(
                async () => textResponse('upstream down', 503),
                async () => {
                    await assert.rejects(
                        strategy.fetch(),
                        /Fetch failed with status code 503: upstream down/,
                    );
                },
            );
        });
    });

    describe('parse()', () => {
        it('formats locations, prose descriptions, externalId hash, and statuses', async () => {
            await withFrozenClock(frozenNow, async () => {
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
        });

        it('handles malformed date ranges, ended items, simple locations and place fallback', async () => {
            await withFrozenClock(frozenNow, async () => {
                const now = Date.now();
                const placeFallbackCalls: string[] = [];
                const fallbackStrategy = new EvnStrategy(
                    'http://evn.test',
                    '*/30 * * * *',
                    createFakeResolver({
                        text: (text) => {
                            placeFallbackCalls.push(text ?? '');
                            return text === 'НЕПОЗНАТО-СКОПЈЕ'
                                ? 'MK0080901'
                                : null;
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
    });
});

describe('VodovodSkopjeStrategy', () => {
    const strategy = new VodovodSkopjeStrategy(
        'http://vodovod.test',
        '*/30 * * * *',
        resolver,
    );

    describe('fetch()', () => {
        it('fetches and validates the upstream payload', async () => {
            await withFetch(
                async () =>
                    jsonResponse({
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
                    }),
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
        it('filters РАЗ test entries, handles ESRI dates, sewage unblocking, and urgency', async () => {
            await withFrozenClock(frozenNow, async () => {
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
        });

        it('covers cancellation, future starts, end-date guards, prose branches and coordinate fallback', async () => {
            await withFrozenClock(frozenNow, async () => {
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
                        text: () => null,
                        coords: { code: 'MK0080907', name: 'Карпош' },
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
    });
});

describe('VodovodKumanovoStrategy', () => {
    const strategy = new VodovodKumanovoStrategy(
        'https://vodovod-kumanovo.test/wp-json/wp/v2/posts',
        '*/30 * * * *',
    );

    describe('fetch()', () => {
        it('fetches and validates the upstream payload', async () => {
            await withFetch(
                async () => jsonResponse([kumanovoPost]),
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
        it('parses daily <li> defect and intervention items, deduplicates within post, and resolves Kumanovo', async () => {
            await withFrozenClock(frozenNow, async () => {
                const todaySkopje = localCalendarDate(new Date());
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
        });

        it('handles <p> fallback, inline/city-wide locations, scheduled dates, and invalid posts', async () => {
            await withFrozenClock(frozenNow, async () => {
                const tomorrowSkopje = localCalendarDate(
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
    });
});

describe('VodovodPrilepStrategy', () => {
    const strategy = new VodovodPrilepStrategy(
        'https://vodovod-prilep.test/wp-json/wp/v2/posts',
        '*/30 * * * *',
    );

    describe('fetch()', () => {
        it('fetches and validates the upstream payload', async () => {
            await withFetch(
                async () => jsonResponse([prilepPost]),
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
        it('stores normal daily supply as omitted, parses street outage time windows, and alerts abnormal supply', async () => {
            await withFrozenClock(frozenNow, async () => {
                const todaySkopje = localCalendarDate(new Date());
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
        });

        it('parses standalone emergency notices, ignores HR/PR posts, and marks historical outages ended', async () => {
            await withFrozenClock(frozenNow, async () => {
                const todaySkopje = localCalendarDate(new Date());
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
                assert.equal(
                    notice.title,
                    'Вонредно известување: н.м. Ореовец',
                );
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
});

describe('OpstinaVelesStrategy', () => {
    const waterStrategy = new OpstinaVelesStrategy(
        'https://veles.test/wp-json/wp/v2/posts',
        '*/30 * * * *',
        'water',
    );
    const roadStrategy = new OpstinaVelesStrategy(
        'https://veles.test/wp-json/wp/v2/posts',
        '*/30 * * * *',
        'road',
    );

    describe('fetch()', () => {
        it('fetches and validates the upstream payload', async () => {
            await withFetch(
                async () => jsonResponse([velesPost]),
                async () => {
                    const result = await waterStrategy.fetch();
                    assert.ok(Array.isArray(result));
                },
            );
        });

        it('rejects non-OK responses', async () => {
            await withFetch(
                async () => textResponse('provider error', 500),
                async () => {
                    await assert.rejects(
                        waterStrategy.fetch(),
                        /Fetch failed with status code 500: provider error/,
                    );
                },
            );
        });
    });

    describe('parse()', () => {
        it('skips EVN-style power notices in every category (covered by the evn source)', async () => {
            await withFrozenClock(frozenNow, async () => {
                const evnPosts = [
                    velesPost,
                    {
                        id: 5012,
                        date: '2026-11-18T09:00:00',
                        date_gmt: '2026-11-18T08:00:00',
                        link: 'https://www.veles.gov.mk/prekin-5012/',
                        title: {
                            rendered:
                                'ПРЕКИН ВО СНАБДУВАЊЕТО СО ЕЛЕКТРИЧНА ЕНЕРГИЈА',
                        },
                        content: {
                            rendered:
                                '<p>Во с. Голо Брдо е планиран прекин во снабдувањето со електрична енергија од 08:00 до 12:00 часот на 22 ноември 2026.</p>',
                        },
                    },
                    {
                        id: 5013,
                        date: '2026-11-18T07:00:00',
                        date_gmt: '2026-11-18T06:00:00',
                        link: 'https://www.veles.gov.mk/normalizirano-5013/',
                        title: { rendered: 'ИЗВЕСТУВАЊЕ' },
                        content: {
                            rendered:
                                '<p>Прекинот во снабдувањето со електрична енергија на ул. Мито Хаџивасилев е нормализиран.</p>',
                        },
                    },
                ];
                for (const strategy of [waterStrategy, roadStrategy]) {
                    assert.deepEqual(await strategy.parse(evnPosts), []);
                }
            });
        });

        it('classifies open-ended water bans and dated network works, skipping PDF-bodied lab reports', async () => {
            await withFrozenClock(frozenNow, async () => {
                const parsed = await waterStrategy.parse([
                    {
                        id: 5021,
                        date: '2026-11-18T10:00:00',
                        date_gmt: '2026-11-18T09:00:00',
                        link: 'https://www.veles.gov.mk/zabrana-5021/',
                        title: { rendered: 'ИЗВЕСТУВАЊЕ' },
                        content: {
                            rendered:
                                '<p>Информираме дека водата не е за пиење сè до укинување на забраната поради хидрантска интервенција во с. Раштани. Со почит, Општина Велес</p>',
                        },
                    },
                    {
                        id: 5022,
                        date: '2026-11-17T09:00:00',
                        date_gmt: '2026-11-17T08:00:00',
                        link: 'https://veles.gov.mk/izveshtaj-5022/',
                        title: {
                            rendered: 'ИЗВЕШТАЈ ОД ТЕСТИРАЊЕ НА ВОДА ЗА ПИЕЊЕ',
                        },
                        content: {
                            rendered:
                                '<p>Објавен е извештај од лабораториското тестирање на безбедноста на водата за пиење од Акумулација Младост.</p><p><a href="https://www.veles.gov.mk/wp-content/uploads/2026/11/izvestaj voda.pdf">Извештај (PDF)</a></p>',
                        },
                    },
                    {
                        id: 5023,
                        date: '2026-11-16T08:30:00',
                        date_gmt: '2026-11-16T07:30:00',
                        link: 'https://www.veles.gov.mk/vodovod-5023/',
                        title: { rendered: 'СООПШТЕНИЕ' },
                        content: {
                            rendered:
                                '<p>Поради реконструкција на водоводната мрежа на ул. Јане Сандански, водоснабдувањето ќе биде отежнато на 19.11.2026 година.</p>',
                        },
                    },
                ]);
                assert.equal(parsed.length, 2);

                const ban = at(parsed, 0);
                assert.equal(ban.title, 'Забрана за вода за пиење: Раштани');
                assert.equal(ban.rawPayload.title, 'ИЗВЕСТУВАЊЕ');
                assert.equal(ban.locationLabel, 'Раштани, Велес');
                assert.equal(ban.status, 'ongoing');
                assert.equal(ban.endsAt, null);
                assert.equal(
                    ban.startsAt?.toISOString(),
                    '2026-11-18T09:00:00.000Z',
                );
                assert.doesNotMatch(present(ban.description), /Со\s+почит/iu);
                assert.deepEqual(Object.keys(ban.rawPayload).sort(), [
                    'date',
                    'dateGmt',
                    'link',
                    'postId',
                    'title',
                ]);
                assert.doesNotMatch(present(ban.description), /\.pdf/iu);

                const works = at(parsed, 1);
                assert.equal(
                    works.title,
                    'Реконструкција на водоводна мрежа: ул. Јане Сандански',
                );
                assert.equal(works.status, 'scheduled');
                assert.equal(
                    works.startsAt?.toISOString(),
                    '2026-11-18T23:00:00.000Z',
                );
                assert.equal(
                    works.endsAt?.toISOString(),
                    '2026-11-19T22:59:59.999Z',
                );
            });
        });

        it('classifies road notices from body text with multi-day and undated windows', async () => {
            await withFrozenClock(frozenNow, async () => {
                const parsed = await roadStrategy.parse([
                    {
                        id: 5031,
                        date: '2026-11-17T10:00:00',
                        date_gmt: '2026-11-17T09:00:00',
                        link: 'https://www.veles.gov.mk/soobshtenie-5031/',
                        title: { rendered: 'ИЗВЕСТУВАЊЕ' },
                        content: {
                            rendered:
                                '<p>Поради асфалтерски работи, времен режим на сообраќај ќе биде воведен во периодот од 08:00 часот на ден 20.11.2026 до 17:00 часот на ден 21.11.2026 на ул. Партизанска.</p>',
                        },
                    },
                    {
                        id: 5032,
                        date: '2026-11-18T08:45:00',
                        date_gmt: '2026-11-18T07:45:00',
                        link: 'https://www.veles.gov.mk/rekonstrukcija-5032/',
                        title: {
                            rendered:
                                'ГРАДЕЖНИ АКТИВНОСТИ НА ПАТНАТА МРЕЖА ВО ВЕЛЕС',
                        },
                        content: {
                            rendered:
                                '<p>Започнаа градежни активности на улица Гоце Делчев и сообраќајот ќе биде отежнат во зоната на работите.</p>',
                        },
                    },
                ]);
                assert.equal(parsed.length, 2);

                const regime = at(parsed, 0);
                assert.equal(
                    regime.title,
                    'Времен режим на сообраќај: ул. Партизанска',
                );
                assert.equal(regime.locationLabel, 'ул. Партизанска, Велес');
                assert.equal(regime.status, 'scheduled');
                assert.equal(
                    regime.startsAt?.toISOString(),
                    '2026-11-20T07:00:00.000Z',
                );
                assert.equal(
                    regime.endsAt?.toISOString(),
                    '2026-11-21T16:00:00.000Z',
                );

                const undated = at(parsed, 1);
                assert.equal(
                    undated.title,
                    'Реконструкција на улица: улица Гоце Делчев',
                );
                assert.equal(undated.locationLabel, 'улица Гоце Делчев, Велес');
                assert.equal(undated.status, 'ongoing');
                assert.equal(undated.endsAt, null);
                assert.equal(
                    undated.startsAt?.toISOString(),
                    '2026-11-18T07:45:00.000Z',
                );
            });
        });

        it('skips non-utility noise in both categories', async () => {
            await withFrozenClock(frozenNow, async () => {
                const noisePosts = [
                    {
                        id: 5041,
                        date: '2026-11-18T09:00:00',
                        date_gmt: '2026-11-18T08:00:00',
                        link: 'https://www.veles.gov.mk/dup-5041/',
                        title: { rendered: 'ЈАВЕН УВИД НА ДУП' },
                        content: {
                            rendered:
                                '<p>Се објавува јавен увид на ДУП за урбанистички план во кој е предвидена реконструкција на водоводната мрежа.</p>',
                        },
                    },
                    {
                        id: 5042,
                        date: '2026-11-18T09:00:00',
                        date_gmt: '2026-11-18T08:00:00',
                        link: 'https://www.veles.gov.mk/povik-5042/',
                        title: {
                            rendered: 'ЈАВЕН ПОВИК ЗА ИЗБОР НА ИЗВЕДУВАЧ',
                        },
                        content: {
                            rendered:
                                '<p>Општина Велес објавува тендер за избор на изведувач за асфалтирање на локални патишта.</p>',
                        },
                    },
                    {
                        id: 5043,
                        date: '2026-11-18T09:00:00',
                        date_gmt: '2026-11-18T08:00:00',
                        link: 'https://www.veles.gov.mk/deratizacija-5043/',
                        title: { rendered: 'ДЕРАТИЗАЦИЈА И ДЕЗИНСЕКЦИЈА' },
                        content: {
                            rendered:
                                '<p>Во периодот од 20.11.2026 до 25.11.2026 ќе се изведува дератизација, дезинфекција и дезинсекција во реонот на трафостаница Велес.</p>',
                        },
                    },
                ];

                for (const strategy of [waterStrategy, roadStrategy]) {
                    assert.deepEqual(await strategy.parse(noisePosts), []);
                }
            });
        });

        it('keeps pothole posts, horizontal marking, and interrupted-traffic notices with date-only multi-day windows', async () => {
            await withFrozenClock(frozenNow, async () => {
                const parsed = await roadStrategy.parse([
                    {
                        id: 5051,
                        date: '2026-11-18T09:30:00',
                        date_gmt: '2026-11-18T08:30:00',
                        link: 'https://www.veles.gov.mk/dupka-5051/',
                        title: { rendered: 'Дупка на коловозот' },
                        content: {
                            rendered:
                                '<p>Поради дупка на коловозот на ул. Партизанска, сообраќајот е отежнат.</p>',
                        },
                    },
                    {
                        id: 5052,
                        date: '2026-11-18T10:00:00',
                        date_gmt: '2026-11-18T09:00:00',
                        link: 'https://www.veles.gov.mk/beleme-5052/',
                        title: {
                            rendered:
                                'ХОРИЗОНТАЛНО БЕЛЕЊЕ НА УЛИЦИТЕ НИЗ ГРАДОТ',
                        },
                        content: {
                            rendered:
                                '<p>Хоризонталното бележење на улиците низ градот ќе се изведува од 20.11.2026 до 25.11.2026.</p>',
                        },
                    },
                    {
                        id: 5053,
                        date: '2026-11-18T11:00:00',
                        date_gmt: '2026-11-18T10:00:00',
                        link: 'https://www.veles.gov.mk/prekinat-5053/',
                        title: {
                            rendered:
                                'Прекинат сообраќајот во Градски парк поради дефект на подземна инсталација',
                        },
                        content: {
                            rendered:
                                '<p>Прекинат сообраќајот во Градски парк поради дефект на подземна инсталација.</p>',
                        },
                    },
                ]);
                assert.equal(parsed.length, 3);

                const pothole = at(parsed, 0);
                assert.equal(pothole.category, 'road');
                assert.equal(
                    pothole.title,
                    'Сообраќајно известување: ул. Партизанска',
                );
                assert.equal(pothole.locationLabel, 'ул. Партизанска, Велес');
                assert.equal(pothole.status, 'ongoing');

                const marking = at(parsed, 1);
                assert.equal(
                    marking.title,
                    'Хоризонтално бележење на улици: Велес',
                );
                assert.equal(marking.locationLabel, 'Велес');
                assert.equal(marking.status, 'scheduled');
                assert.equal(
                    marking.startsAt?.toISOString(),
                    '2026-11-19T23:00:00.000Z',
                );
                assert.equal(
                    marking.endsAt?.toISOString(),
                    '2026-11-25T22:59:59.999Z',
                );

                const interrupted = at(parsed, 2);
                assert.equal(interrupted.category, 'road');
                assert.equal(interrupted.locationLabel, 'Велес');
                assert.equal(interrupted.status, 'ongoing');
            });
        });

        it('extracts Св. streets, village lists and transformer stations, and skips title-only lab reports', async () => {
            await withFrozenClock(frozenNow, async () => {
                const waterParsed = await waterStrategy.parse([
                    {
                        id: 5061,
                        date: '2026-11-18T09:00:00',
                        date_gmt: '2026-11-18T08:00:00',
                        link: 'https://www.veles.gov.mk/sv-kiril-5061/',
                        title: { rendered: 'ул. Св. Кирил и Методиј' },
                        content: {
                            rendered:
                                '<p>Поради реконструкција на водоводната мрежа на ул. Св. Кирил и Методиј, водоснабдувањето ќе биде отежнато.</p>',
                        },
                    },
                    {
                        id: 5062,
                        date: '2026-11-18T09:10:00',
                        date_gmt: '2026-11-18T08:10:00',
                        link: 'https://www.veles.gov.mk/ivankovci-5062/',
                        title: { rendered: 'ВО СЕЛАТА ИВАНКОВЦИ И КУМАРИНО' },
                        content: {
                            rendered:
                                '<p>Поради реконструкција на водоводната мрежа, водоснабдувањето во селата Иванковци и Кумарино ќе биде отежнато.</p>',
                        },
                    },
                    {
                        id: 5063,
                        date: '2026-11-17T09:00:00',
                        date_gmt: '2026-11-17T08:00:00',
                        link: 'https://www.veles.gov.mk/izvestaj-5063/',
                        title: {
                            rendered: 'ИЗВЕШТАЈ ОД ТЕСТИРАЊЕ НА ВОДА ЗА ПИЕЊЕ',
                        },
                        content: {
                            rendered:
                                "<p><a href='/downloads/2026/izvestaj voda.pdf&amp;x=1'>Прочитајте го документот</a></p>",
                        },
                    },
                ]);
                assert.equal(waterParsed.length, 2);

                const svStreet = at(waterParsed, 0);
                assert.equal(
                    svStreet.title,
                    'Реконструкција на водоводна мрежа: ул. Св. Кирил и Методиј',
                );
                assert.equal(
                    svStreet.locationLabel,
                    'ул. Св. Кирил и Методиј, Велес',
                );
                assert.equal(svStreet.status, 'ongoing');

                const villages = at(waterParsed, 1);
                assert.equal(
                    villages.locationLabel,
                    'Иванковци и Кумарино, Велес',
                );
                assert.deepEqual(Object.keys(svStreet.rawPayload).sort(), [
                    'date',
                    'dateGmt',
                    'link',
                    'postId',
                    'title',
                ]);
                assert.doesNotMatch(present(svStreet.description), /\.pdf/iu);
            });
        });

        it('skips PDF-bodied water lab/testing reports', async () => {
            await withFrozenClock(frozenNow, async () => {
                const parsed = await waterStrategy.parse([
                    {
                        id: 5081,
                        date: '2026-11-17T09:00:00',
                        date_gmt: '2026-11-17T08:00:00',
                        link: 'https://veles.gov.mk/izveshtaj-5081/',
                        title: {
                            rendered:
                                'ИЗВЕШТАЈ БЕЗБЕДНОСТ НА ВОДА ЗА ПИЕЊЕ ОД АКУМУЛАЦИЈА МЛАДОСТ',
                        },
                        content: {
                            rendered:
                                '<p>Објавен е извештај од лабораториското тестирање на безбедноста на водата за пиење од Акумулација Младост.</p><p><a href="https://www.veles.gov.mk/wp-content/uploads/2026/11/izvestaj voda.pdf">Извештај (PDF)</a></p>',
                        },
                    },
                    {
                        id: 5082,
                        date: '2026-11-16T09:00:00',
                        date_gmt: '2026-11-16T08:00:00',
                        link: 'https://veles.gov.mk/izveshtaj-5082/',
                        title: {
                            rendered: 'ИЗВЕШТАИ ОД ТЕСТИРАЊЕ НА ВОДА ЗА ПИЕЊЕ',
                        },
                        content: {
                            rendered:
                                "<p><a href='/downloads/2026/izvestaj voda.pdf&amp;x=1'>Прочитајте го документот</a></p>",
                        },
                    },
                ]);
                assert.deepEqual(parsed, []);
            });
        });

        it('keeps do-not-drink bans that cite a lab report in the body', async () => {
            await withFrozenClock(frozenNow, async () => {
                const parsed = await waterStrategy.parse([
                    {
                        id: 5091,
                        date: '2026-11-18T09:00:00',
                        date_gmt: '2026-11-18T08:00:00',
                        link: 'https://www.veles.gov.mk/zabrana-5091/',
                        title: { rendered: 'ИЗВЕСТУВАЊЕ' },
                        content: {
                            rendered:
                                '<p>Водата не е за пиење во с. Раштани, сè до укинување на забраната, врз основа на извештајот од лабораториското тестирање.</p>',
                        },
                    },
                ]);
                assert.equal(parsed.length, 1);

                const ban = at(parsed, 0);
                assert.equal(ban.status, 'ongoing');
                assert.equal(ban.endsAt, null);
                assert.equal(ban.locationLabel, 'Раштани, Велес');
                assert.match(
                    present(ban.description),
                    /извештајот од лабораториското тестирање/,
                );
            });
        });

        it('skips cultural "дневни" posts and rejects "Повеќе" boilerplate as a location', async () => {
            await withFrozenClock(frozenNow, async () => {
                const parsed = await waterStrategy.parse([
                    {
                        id: 5071,
                        date: '2026-11-18T09:00:00',
                        date_gmt: '2026-11-18T08:00:00',
                        link: 'https://www.veles.gov.mk/kultura-5071/',
                        title: { rendered: 'КУЛТУРНИ НАСТАНИ ВО ВЕЛЕС' },
                        content: {
                            rendered:
                                '<p>Општина Велес ги објавува дневни настани за граѓаните во градскиот парк.</p>',
                        },
                    },
                    {
                        id: 5072,
                        date: '2026-11-18T10:00:00',
                        date_gmt: '2026-11-18T09:00:00',
                        link: 'https://www.veles.gov.mk/voda-5072/',
                        title: { rendered: 'ИЗВЕСТУВАЊЕ' },
                        content: {
                            rendered:
                                '<p>Водоснабдувањето е нормализирано во с. Повеќе информации на нашиот веб-сајт.</p>',
                        },
                    },
                ]);
                assert.equal(parsed.length, 1);

                const boilerplate = at(parsed, 0);
                assert.equal(boilerplate.title, 'Водоснабдување: Велес');
                assert.equal(boilerplate.locationLabel, 'Велес');
            });
        });

        it('classifies street reconstruction titles as road even when the body mentions water pipes', async () => {
            await withFrozenClock(frozenNow, async () => {
                const posts = [
                    {
                        id: 5081,
                        date: '2026-11-18T09:00:00',
                        date_gmt: '2026-11-18T08:00:00',
                        link: 'https://www.veles.gov.mk/rekonstrukcija-5081/',
                        title: {
                            rendered:
                                'Реконструкцијата на улицата „Васил Ѓорѓов“ во завршна фаза',
                        },
                        content: {
                            rendered: [
                                '<p>Во рамките на активностите се заменуваат и водоводните траци, а сообраќајот во зоната на работите е отежнат.</p>',
                                '<noscript><a href="https://www.veles.gov.mk/galerija/slika-1.jpg"><img src="https://www.veles.gov.mk/galerija/slika-1.jpg" /></a></noscript>',
                            ].join('\n'),
                        },
                    },
                ];
                const parsed = await roadStrategy.parse(posts);
                assert.equal(parsed.length, 1);
                assert.equal(at(parsed, 0).category, 'road');
                assert.doesNotMatch(
                    present(at(parsed, 0).description),
                    /slika-1\.jpg/,
                );
                assert.deepEqual(await waterStrategy.parse(posts), []);
            });
        });

        it('parses multi-day windows joined by "па се до" and extracts "улица во село" locations', async () => {
            await withFrozenClock(frozenNow, async () => {
                const parsed = await roadStrategy.parse([
                    {
                        id: 5082,
                        date: '2026-11-18T09:00:00',
                        date_gmt: '2026-11-18T08:00:00',
                        link: 'https://www.veles.gov.mk/beleme-5082/',
                        title: { rendered: 'ИЗВЕСТУВАЊЕ' },
                        content: {
                            rendered:
                                '<p>Поради асфалтерски работи, времен режим на сообраќај ќе биде воведен од 08:00 часот на ден 08.10.2026 па се до 21:00 часот на ден 12.10.2026 на ул. Партизанска.</p>',
                        },
                    },
                    {
                        id: 5083,
                        date: '2026-11-18T10:00:00',
                        date_gmt: '2026-11-18T09:00:00',
                        link: 'https://www.veles.gov.mk/orizari-5083/',
                        title: {
                            rendered:
                                'Реконструкција на улица во село Горно Оризари',
                        },
                        content: {
                            rendered:
                                '<p>Започна реконструкција на улица во село Горно Оризари, а сообраќајот ќе биде отежнат во зоната на работите.</p>',
                        },
                    },
                ]);
                assert.equal(parsed.length, 2);

                const multiDay = at(parsed, 0);
                assert.equal(multiDay.status, 'ended');
                assert.equal(
                    multiDay.startsAt?.toISOString(),
                    '2026-10-08T06:00:00.000Z',
                );
                assert.equal(
                    multiDay.endsAt?.toISOString(),
                    '2026-10-12T19:00:00.000Z',
                );

                const villageStreet = at(parsed, 1);
                assert.equal(
                    villageStreet.locationLabel,
                    'Горно Оризари, Велес',
                );
            });
        });

        it('formats subject-plus-location titles and strips PR boilerplate from descriptions', async () => {
            await withFrozenClock(frozenNow, async () => {
                const waterParsed = await waterStrategy.parse([
                    {
                        id: 5101,
                        date: '2026-11-18T09:00:00',
                        date_gmt: '2026-11-18T08:00:00',
                        link: 'https://www.veles.gov.mk/karaslari-5101/',
                        title: {
                            rendered:
                                'РЕКОНСТРУКЦИЈА НА ВОДОВОДНАТА ЛИНИЈА ВО СЕЛО КАРАСЛАРИ',
                        },
                        content: {
                            rendered:
                                '<p>Поради реконструкција на водоводната линија во село Караслари, водоснабдувањето ќе биде отежнато на 19.11.2026 година.</p>',
                        },
                    },
                ]);
                assert.equal(waterParsed.length, 1);
                assert.equal(
                    at(waterParsed, 0).title,
                    'Реконструкција на водоводна мрежа: Караслари',
                );

                const roadParsed = await roadStrategy.parse([
                    {
                        id: 5102,
                        date: '2026-11-18T10:00:00',
                        date_gmt: '2026-11-18T09:00:00',
                        link: 'https://www.veles.gov.mk/orizari-5102/',
                        title: {
                            rendered:
                                'РЕКОНСТРУКЦИЈА НА УЛИЦА ВО СЕЛО ГОРНО ОРИЗАРИ',
                        },
                        content: {
                            rendered:
                                '<p>Започна реконструкција на улица во село Горно Оризари, а сообраќајот ќе биде отежнат во зоната на работите.</p>',
                        },
                    },
                    {
                        id: 5103,
                        date: '2026-11-18T11:00:00',
                        date_gmt: '2026-11-18T10:00:00',
                        link: 'https://www.veles.gov.mk/dzhordzhov-5103/',
                        title: {
                            rendered:
                                'РЕКОНСТРУКЦИЈА НА УЛИЦА „ВАСИЛ ЃОРЃОВ“ ВО СЕЛО КАРАСЛАРИ',
                        },
                        content: {
                            rendered: [
                                '<p>Општина Велес континуирано вложува финансиски средства во локалната патна инфраструктура.</p>',
                                '<p>Реконструкцијата се реализираше со сопствени финансиски средства на Општина Велес.</p>',
                                '<p>Со оваа активност се подобрува безбедноста на сообраќајот во село Караслари.</p>',
                                '<p>Реконструкцијата на улицата „Васил Ѓорѓов“ во с. Караслари започна на 15.11.2026 год. и ги вклучува асфалтирањето и хоризонталното бележење.</p>',
                                '<p>Сообраќајот во зоната на работите е отежнат во периодот од 20.11.2026 до 25.11.2026 година.</p>',
                                '<p>Општина Велес ги замолува граѓаните за разбирливост и трпение.</p>',
                                '<p>Со почит, Општина Велес</p>',
                            ].join('\n'),
                        },
                    },
                ]);
                assert.equal(roadParsed.length, 2);
                assert.equal(
                    at(roadParsed, 0).title,
                    'Реконструкција на улица: Горно Оризари',
                );

                const roadWorks = at(roadParsed, 1);
                assert.equal(
                    roadWorks.title,
                    'Реконструкција на улица: Улица Васил Ѓорѓов',
                );
                assert.equal(
                    roadWorks.rawPayload.title,
                    'РЕКОНСТРУКЦИЈА НА УЛИЦА „ВАСИЛ ЃОРЃОВ“ ВО СЕЛО КАРАСЛАРИ',
                );
                assert.equal(
                    roadWorks.description,
                    'Реконструкцијата на улицата „Васил Ѓорѓов“ во с. Караслари започна на 15.11.2026 год. и ги вклучува асфалтирањето и хоризонталното бележење. Сообраќајот во зоната на работите е отежнат во периодот од 20.11.2026 до 25.11.2026 година.',
                );
                assert.doesNotMatch(
                    present(roadWorks.description),
                    /финансиски средства/iu,
                );
                assert.doesNotMatch(
                    present(roadWorks.description),
                    /континуирано вложува/iu,
                );
                assert.doesNotMatch(
                    present(roadWorks.description),
                    /ги замолува граѓаните/iu,
                );
            });
        });

        it('age-gates open-ended bans and undated notices at their TTL boundaries', async () => {
            await withFrozenClock(frozenNow, async () => {
                const makePost = (
                    id: number,
                    dateGmt: string,
                    body: string,
                ) => ({
                    id,
                    date: dateGmt,
                    date_gmt: dateGmt,
                    link: `https://www.veles.gov.mk/ttl-${id}/`,
                    title: { rendered: 'ИЗВЕСТУВАЊЕ' },
                    content: { rendered: body },
                });
                const banBody =
                    '<p>Информираме дека водата не е за пиење сè до укинување на забраната поради хидрантска интервенција во с. Раштани. Со почит, Општина Велес</p>';
                const undatedWaterBody =
                    '<p>Поради реконструкција на водоводната мрежа на ул. Јане Сандански, водоснабдувањето ќе биде отежнато.</p>';
                const undatedRoadBody =
                    '<p>Започнаа градежни активности на улица Гоце Делчев и сообраќајот ќе биде отежнат во зоната на работите.</p>';

                const banAtEdge = at(
                    await waterStrategy.parse([
                        makePost(5111, '2026-11-04T12:00:00', banBody),
                    ]),
                    0,
                );
                assert.equal(banAtEdge.status, 'ongoing');
                assert.equal(banAtEdge.endsAt, null);

                const banPastEdge = at(
                    await waterStrategy.parse([
                        makePost(5112, '2026-11-04T11:59:59.999', banBody),
                    ]),
                    0,
                );
                assert.equal(banPastEdge.status, 'ended');
                assert.equal(banPastEdge.endsAt, null);

                const waterAtEdge = at(
                    await waterStrategy.parse([
                        makePost(5113, '2026-11-15T12:00:00', undatedWaterBody),
                    ]),
                    0,
                );
                assert.equal(waterAtEdge.status, 'ongoing');
                assert.equal(waterAtEdge.endsAt, null);

                const waterPastEdge = at(
                    await waterStrategy.parse([
                        makePost(
                            5114,
                            '2026-11-15T11:59:59.999',
                            undatedWaterBody,
                        ),
                    ]),
                    0,
                );
                assert.equal(waterPastEdge.status, 'ended');
                assert.equal(waterPastEdge.endsAt, null);

                const roadAtEdge = at(
                    await roadStrategy.parse([
                        makePost(5115, '2026-11-11T12:00:00', undatedRoadBody),
                    ]),
                    0,
                );
                assert.equal(roadAtEdge.status, 'ongoing');
                assert.equal(roadAtEdge.endsAt, null);

                const roadPastEdge = at(
                    await roadStrategy.parse([
                        makePost(
                            5116,
                            '2026-11-11T11:59:59.999',
                            undatedRoadBody,
                        ),
                    ]),
                    0,
                );
                assert.equal(roadPastEdge.status, 'ended');
                assert.equal(roadPastEdge.endsAt, null);
            });
        });
    });
});

describe('OpstinaDebrcaStrategy', () => {
    const strategy = new OpstinaDebrcaStrategy(
        'https://debrca.test/wp-json/wp/v2/posts',
        '*/30 * * * *',
    );

    describe('fetch()', () => {
        it('fetches and validates the upstream payload', async () => {
            await withFetch(
                async () => jsonResponse([debrcaPost]),
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
        it('maps turbidity and do-not-drink warnings onto ongoing open-ended reports', async () => {
            await withFrozenClock(frozenNow, async () => {
                const parsed = await strategy.parse([
                    debrcaPost,
                    {
                        id: 10306,
                        date: '2026-11-16T17:12:42',
                        date_gmt: '2026-11-16T15:12:42',
                        link: 'https://debrca.gov.mk/izvestuvanje-matnost-trebenishta/',
                        title: {
                            rendered:
                                'Известување Поради појава на матност во водоводната мрежа во с.Требеништа водата да не се користи за пиење до стабилизирање на состојбата',
                        },
                        content: {
                            rendered:
                                '<p>Известување<br />\nПоради појава на матност во водоводната мрежа во с.Требеништа водата да не се користи за пиење до стабилизирање на состојбата.<br />\nЕкипите на Јп превземаат активности за детектирање на матноста за што се ангажирани надворешни стручни лица &#8211; хидроинжинери за проверка на состојбата на резервоарот, изворите и водоводната мрежа.<br />\nЗа наодите од стручниот извештај ќе биде објавено известување.</p>\n',
                        },
                    },
                    {
                        id: 10266,
                        date: '2026-11-15T14:33:52',
                        date_gmt: '2026-11-15T12:33:52',
                        link: 'https://debrca.gov.mk/izvestuvanje-belchishta/',
                        title: {
                            rendered:
                                'Известување до населени места Белчишта, Ботун, Лешани, Ново Село, Долно и Горно Средорече, Грко Поле',
                        },
                        content: {
                            rendered:
                                '<p><span data-olk-copy-source="MessageBody">Известување до населени места Белчишта, Ботун, Лешани, Ново Село, Долно и Горно Средорече, Грко поле дека поради дефект во централата и ископи со механизација кај централата Хец Песочан поради нивни активности, има заматеност на дел од изворите во водоснабдителниот систем Караорман. До стабилизирање на состојбата не се препорачува пиење на водата</span></p>\n',
                        },
                    },
                ]);
                assert.equal(parsed.length, 3);

                for (const report of parsed) {
                    assert.equal(report.source, 'opstina-debrca');
                    assert.equal(report.category, 'water');
                    assert.equal(report.municipalityCode, 'MK0030400');
                    assert.equal(report.status, 'ongoing');
                    assert.equal(report.endsAt, null);
                }

                const turbidity = at(parsed, 0);
                assert.equal(turbidity.externalId.length, 32);
                assert.equal(
                    turbidity.title,
                    'Забрана за вода за пиење: Арбиново и Слатински Чифлик',
                );
                assert.equal(
                    turbidity.rawPayload.title,
                    'Известување до населени места Арбиново и Слатински Чифлик за заматеност за водата за пиење',
                );
                assert.equal(
                    turbidity.locationLabel,
                    'Арбиново и Слатински Чифлик, Дебрца',
                );
                assert.equal(
                    turbidity.startsAt?.toISOString(),
                    '2026-11-17T14:12:05.000Z',
                );
                assert.doesNotMatch(present(turbidity.description), /почит/iu);
                assert.doesNotMatch(present(turbidity.description), /ЈКП/iu);
                assert.deepEqual(Object.keys(turbidity.rawPayload).sort(), [
                    'date',
                    'dateGmt',
                    'link',
                    'postId',
                    'title',
                ]);

                const trebenishta = at(parsed, 1);
                assert.equal(
                    trebenishta.title,
                    'Забрана за вода за пиење: Требеништа',
                );
                assert.equal(trebenishta.locationLabel, 'Требеништа, Дебрца');
                assert.equal(
                    trebenishta.description,
                    'Известување Поради појава на матност во водоводната мрежа во с.Требеништа водата да не се користи за пиење до стабилизирање на состојбата.',
                );

                const belchishta = at(parsed, 2);
                assert.equal(
                    belchishta.title,
                    'Забрана за вода за пиење: Белчишта, Ботун, Лешани, Ново Село, Долно и Горно Средорече и Грко Поле',
                );
                assert.equal(
                    belchishta.locationLabel,
                    'Белчишта, Ботун, Лешани, Ново Село, Долно и Горно Средорече и Грко Поле, Дебрца',
                );
            });
        });

        it('parses pump and pipe defect outages with village lists and cleans Outlook signatures', async () => {
            await withFrozenClock(frozenNow, async () => {
                const parsed = await strategy.parse([
                    {
                        id: 10298,
                        date: '2026-11-16T10:47:45',
                        date_gmt: '2026-11-16T08:47:45',
                        link: 'https://debrca.gov.mk/izvestuvanje-prekin-podmolje/',
                        title: {
                            rendered:
                                'Известување за прекин во водоснабдување поради дефект на водоводна пумпна станица Св.Еразмо',
                        },
                        content: {
                            rendered:
                                '<p>Се известуваат жителите на с.Подмоље, с.Оровник, с.Горенци, с.Требеништа и с.Волино дека поради дефект на водоводна цевка ф315 ќе има намален притисок и прекин на водоснабдувањето.</p>\n<p>&nbsp;</p>\n<p>&nbsp;</p>\n<p>Со почит,</p>\n<p>&nbsp;</p>\n<p>ЈКП Дебрца</p>\n',
                        },
                    },
                ]);
                assert.equal(parsed.length, 1);

                const outage = at(parsed, 0);
                assert.equal(outage.status, 'ongoing');
                assert.equal(outage.endsAt, null);
                assert.equal(
                    outage.title,
                    'Прекин во водоснабдувањето: Подмоље, Оровник, Горенци, Требеништа и Волино',
                );
                assert.equal(
                    outage.locationLabel,
                    'Подмоље, Оровник, Горенци, Требеништа и Волино, Дебрца',
                );
                assert.equal(
                    outage.description,
                    'Се известуваат жителите на с.Подмоље, с.Оровник, с.Горенци, с.Требеништа и с.Волино дека поради дефект на водоводна цевка ф315 ќе има намален притисок и прекин на водоснабдувањето.',
                );
            });
        });

        it('stores water-safe lab verdicts as omitted with PDF attachments stripped', async () => {
            await withFrozenClock(frozenNow, async () => {
                const parsed = await strategy.parse([
                    {
                        id: 10336,
                        date: '2026-10-30T13:46:08',
                        date_gmt: '2026-10-30T12:46:08',
                        link: 'https://debrca.gov.mk/soobshtenie-kvalitet-voda/',
                        title: {
                            rendered:
                                'Соопштение за испитување на квалитетот на водата од водоводните системи за селата Волино, Горенци, Мешеишта, Оровник, Подмоље и Требеништа',
                        },
                        content: {
                            rendered:
                                '<p>Врз основа на извршените испитувања на квалитетот на водата за пиење од водоводните системи во селата Волино, Горенци, Мешеишта, Оровник, Подмоље и Требеништа и добиените лабораториски резултати, констатирано е дека водата од наведените водоводни системи е <strong>здравствено исправна и безбедна за консумирање</strong>.</p>\n<p>Граѓаните од овие населени места можат слободно да ја користат водата за пиење и за секојдневните потреби.</p>\n<p>Општина Дебрца и ЈКП Дебрца и понатаму ќе продолжат со следење и контрола на квалитетот на водата, со цел заштита на здравјето на населението.</p>\n<p>&nbsp;</p>\n<p>Прилог детални извештаи по населени места:</p>\n<p><a href="https://debrca.gov.mk/wp-content/uploads/2026/10/подмоље.pdf" target="_blank" rel="noopener">подмоље</a></p>\n<p><a href="https://debrca.gov.mk/wp-content/uploads/2026/10/требеништа.pdf" target="_blank" rel="noopener">требеништа</a></p>\n<p style="text-align: right;">Општина Дебрца</p>\n<p style="text-align: right;">ЈКП Дебрца</p>\n',
                        },
                    },
                ]);
                assert.equal(parsed.length, 1);

                const verdict = at(parsed, 0);
                assert.equal(verdict.status, 'omitted');
                assert.equal(verdict.endsAt, null);
                assert.equal(
                    verdict.title,
                    'Водата е безбедна за пиење: Волино, Горенци, Мешеишта, Оровник, Подмоље и Требеништа',
                );
                assert.equal(
                    verdict.locationLabel,
                    'Волино, Горенци, Мешеишта, Оровник, Подмоље и Требеништа, Дебрца',
                );
                assert.doesNotMatch(present(verdict.description), /\.pdf/iu);
                assert.doesNotMatch(
                    present(verdict.description),
                    /Прилог\s+детални\s+извештаи/iu,
                );
                assert.match(
                    present(verdict.description),
                    /здравствено исправна и безбедна за консумирање\.$/,
                );
            });
        });

        it('parses explicit body dates into real windows with derived statuses', async () => {
            await withFrozenClock(frozenNow, async () => {
                const parsed = await strategy.parse([
                    {
                        id: 10200,
                        date: '2026-11-05T09:00:00',
                        date_gmt: '2026-11-05T08:00:00',
                        link: 'https://debrca.gov.mk/prekin-mesheishta/',
                        title: { rendered: 'Известување за саниран дефект' },
                        content: {
                            rendered:
                                '<p>Прекинот во водоснабдувањето за жителите на с.Мешеишта на ден 05.11.2026 година од 08:00 до 14:00 часот е отстранет.</p>\n',
                        },
                    },
                    {
                        id: 10201,
                        date: '2026-10-20T09:00:00',
                        date_gmt: '2026-10-20T07:00:00',
                        link: 'https://debrca.gov.mk/matnost-zlesti/',
                        title: {
                            rendered: 'Известување за заматеност на водата',
                        },
                        content: {
                            rendered:
                                '<p>ВО ПЕРИОДОТ ОД 20.10.2026 ДО 25.10.2026 година жителите на с.Злести не смеат да ја користат водата за пиење поради заматеност.</p>\n',
                        },
                    },
                    {
                        id: 10202,
                        date: '2026-11-18T09:00:00',
                        date_gmt: '2026-11-18T08:00:00',
                        link: 'https://debrca.gov.mk/najava-prekin-pesochan/',
                        title: {
                            rendered: 'Најава на прекин во водоснабдувањето',
                        },
                        content: {
                            rendered:
                                '<p>Прекин во водоснабдувањето за жителите на с.Песочан на ден 20.11.2026 од 08:00 до 12:00 часот.</p>\n',
                        },
                    },
                ]);
                assert.equal(parsed.length, 3);

                const singleDay = at(parsed, 0);
                assert.equal(singleDay.status, 'ended');
                assert.equal(
                    singleDay.startsAt?.toISOString(),
                    '2026-11-05T07:00:00.000Z',
                );
                assert.equal(
                    singleDay.endsAt?.toISOString(),
                    '2026-11-05T13:00:00.000Z',
                );
                assert.equal(singleDay.locationLabel, 'Мешеишта, Дебрца');

                const period = at(parsed, 1);
                assert.equal(period.status, 'ended');
                assert.equal(
                    period.startsAt?.toISOString(),
                    '2026-10-19T22:00:00.000Z',
                );
                assert.equal(
                    period.endsAt?.toISOString(),
                    '2026-10-25T22:59:59.999Z',
                );
                assert.equal(period.locationLabel, 'Злести, Дебрца');

                const upcoming = at(parsed, 2);
                assert.equal(upcoming.status, 'scheduled');
                assert.equal(
                    upcoming.startsAt?.toISOString(),
                    '2026-11-20T07:00:00.000Z',
                );
                assert.equal(
                    upcoming.endsAt?.toISOString(),
                    '2026-11-20T11:00:00.000Z',
                );
                assert.equal(upcoming.locationLabel, 'Песочан, Дебрца');
            });
        });

        it('skips waste collection, fire appeals, and PR/governance noise', async () => {
            await withFrozenClock(frozenNow, async () => {
                const noisePosts = [
                    {
                        id: 10243,
                        date: '2026-09-09T08:59:21',
                        date_gmt: '2026-09-09T06:59:21',
                        link: 'https://debrca.gov.mk/kanti-za-odpad/',
                        title: {
                            rendered:
                                'Набавени 250 канти за комунален отпад со волумен 240л',
                        },
                        content: {
                            rendered:
                                '<p>Денес до општина Дебрца се доставени 250 канти со зафатнина од 240 литри, наменети за чистење на водоводните шахти.</p>\n',
                        },
                    },
                    {
                        id: 10325,
                        date: '2026-10-19T08:55:44',
                        date_gmt: '2026-10-19T06:55:44',
                        link: 'https://debrca.gov.mk/apel-požari/',
                        title: {
                            rendered:
                                'ОТВОРЕН АПЕЛ И СООПШТЕНИЕ ДО ЈАВНОСТА ПОРАДИ ОПАСНОСТА ОД ПОЖАРИ',
                        },
                        content: {
                            rendered:
                                '<p>Противпожарните екипи дејствуваат крај водоводните инсталации за да ги заштитат изворите.</p>\n',
                        },
                    },
                    {
                        id: 10294,
                        date: '2026-10-05T09:10:24',
                        date_gmt: '2026-10-05T07:10:24',
                        link: 'https://debrca.gov.mk/javen-povik-upraven-odbor/',
                        title: {
                            rendered:
                                'ЈАВЕН ПОВИК за избор на членови на Управен одбор на ЈПКД „Дебрца“ с.Белчишта',
                        },
                        content: {
                            rendered:
                                '<p>Советот на општина Дебрца објавува јавен повик за избор на членови на Управен одбор, задолжен и за водоводните системи.</p>\n',
                        },
                    },
                    {
                        id: 9461,
                        date: '2026-08-04T15:03:35',
                        date_gmt: '2026-08-04T13:03:35',
                        link: 'https://debrca.gov.mk/novo-komunalno-vozilo/',
                        title: {
                            rendered: 'Набавено целосно ново комунално возило',
                        },
                        content: {
                            rendered:
                                '<p>Возилото ќе служи за одржување на водоснабдителните системи во општината.</p>\n',
                        },
                    },
                    {
                        id: 9400,
                        date: '2026-08-04T14:50:00',
                        date_gmt: '2026-08-04T12:50:00',
                        link: 'https://debrca.gov.mk/nov-traktor/',
                        title: {
                            rendered: 'Набавен нов трактор за комунални работи',
                        },
                        content: {
                            rendered:
                                '<p>Тракторот ќе се користи за одржување на водоснабдителните системи.</p>\n',
                        },
                    },
                    {
                        id: 10309,
                        date: '2026-10-15T07:50:29',
                        date_gmt: '2026-10-15T05:50:29',
                        link: 'https://debrca.gov.mk/raschistuvanje-kanali/',
                        title: {
                            rendered:
                                'Интензивно се расчистуваат каналите, речните корита во општина Дебрца',
                        },
                        content: {
                            rendered:
                                '<p>Во цела општина ги чистиме каналите крај водоводната мрежа.</p>\n',
                        },
                    },
                    {
                        id: 9386,
                        date: '2026-08-04T14:45:51',
                        date_gmt: '2026-08-04T12:45:51',
                        link: 'https://debrca.gov.mk/mashina-kanalizacija/',
                        title: {
                            rendered:
                                'Набавена нова машина за чистење на канализациони системи',
                        },
                        content: {
                            rendered:
                                '<p>Машината е наменета за чистење и одржување на канализационите системи и водоводните шахти.</p>\n',
                        },
                    },
                ];

                assert.deepEqual(await strategy.parse(noisePosts), []);
            });
        });

        it('cleans Outlook entities, strips signatures, and falls back to a municipality-wide label', async () => {
            await withFrozenClock(frozenNow, async () => {
                const parsed = await strategy.parse([
                    {
                        id: 10260,
                        date: '2026-11-18T09:00:00',
                        date_gmt: '2026-11-18T08:00:00',
                        link: 'https://debrca.gov.mk/defekt-cevka/',
                        title: {
                            rendered: 'Известување за намален притисок',
                        },
                        content: {
                            rendered:
                                '<p>Поради дефект на водоводната цевка &#8211; ф315 ќе има намален притисок во поголемиот дел од општината.</p>\n<p>&nbsp;</p>\n<p>Со Почит,</p>\n<p>&nbsp;</p>\n<p>ЈКП ДЕБРЦА</p>\n',
                        },
                    },
                ]);
                assert.equal(parsed.length, 1);

                const report = at(parsed, 0);
                assert.equal(
                    report.title,
                    'Прекин во водоснабдувањето: Дебрца',
                );
                assert.equal(report.locationLabel, 'Дебрца');
                assert.equal(report.status, 'ongoing');
                assert.equal(report.endsAt, null);
                assert.equal(
                    report.startsAt?.toISOString(),
                    '2026-11-18T08:00:00.000Z',
                );
                assert.match(present(report.description), /цевка – ф315/);
                assert.doesNotMatch(present(report.description), /ЈКП/iu);
            });
        });

        it('keeps open-ended bans ongoing at exactly 14d and ends them at 14d + 1ms', async () => {
            await withFrozenClock(frozenNow, async () => {
                const atTtl = await strategy.parse([
                    {
                        id: 10350,
                        date: '2026-11-04T14:00:00',
                        date_gmt: '2026-11-04T12:00:00',
                        link: 'https://debrca.gov.mk/matnost-grko-pole-ban/',
                        title: {
                            rendered:
                                'Известување водата да не се користи за пиење до стабилизирање на состојбата',
                        },
                        content: {
                            rendered:
                                '<p>Поради заматеност на водата, водата да не се користи за пиење до стабилизирање на состојбата.</p>\n',
                        },
                    },
                ]);
                assert.equal(at(atTtl, 0).status, 'ongoing');

                const pastTtl = await strategy.parse([
                    {
                        id: 10351,
                        date: '2026-11-04T13:59:59.999',
                        date_gmt: '2026-11-04T11:59:59.999',
                        link: 'https://debrca.gov.mk/matnost-grko-pole-ban-2/',
                        title: {
                            rendered:
                                'Известување водата да не се користи за пиење до стабилизирање на состојбата',
                        },
                        content: {
                            rendered:
                                '<p>Поради заматеност на водата, водата да не се користи за пиење до стабилизирање на состојбата.</p>\n',
                        },
                    },
                ]);
                const report = at(pastTtl, 0);
                assert.equal(report.status, 'ended');
                assert.equal(report.endsAt, null);
            });
        });

        it('keeps undated water outages ongoing at exactly 3d and ends them at 3d + 1ms', async () => {
            await withFrozenClock(frozenNow, async () => {
                const atTtl = await strategy.parse([
                    {
                        id: 10352,
                        date: '2026-11-15T14:00:00',
                        date_gmt: '2026-11-15T12:00:00',
                        link: 'https://debrca.gov.mk/prekin-volino-ban/',
                        title: {
                            rendered:
                                'Известување за намален притисок и прекин на водоснабдувањето',
                        },
                        content: {
                            rendered:
                                '<p>Поради дефект на водоводна цевка ќе има намален притисок и прекин на водоснабдувањето.</p>\n',
                        },
                    },
                ]);
                assert.equal(at(atTtl, 0).status, 'ongoing');

                const pastTtl = await strategy.parse([
                    {
                        id: 10353,
                        date: '2026-11-15T13:59:59.999',
                        date_gmt: '2026-11-15T11:59:59.999',
                        link: 'https://debrca.gov.mk/prekin-volino-ban-2/',
                        title: {
                            rendered:
                                'Известување за намален притисок и прекин на водоснабдувањето',
                        },
                        content: {
                            rendered:
                                '<p>Поради дефект на водоводна цевка ќе има намален притисок и прекин на водоснабдувањето.</p>\n',
                        },
                    },
                ]);
                const report = at(pastTtl, 0);
                assert.equal(report.status, 'ended');
                assert.equal(report.endsAt, null);
            });
        });
    });
});

describe('MeteoalarmStrategy', () => {
    const strategy = new MeteoalarmStrategy(
        'http://meteoalarm.test',
        '*/15 * * * *',
        resolver,
    );

    describe('fetch()', () => {
        it('fetches and validates the upstream payload', async () => {
            await withFetch(
                async () => jsonResponse({ warnings: [alert] }),
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
        it('ignores ?????? strings, maps awareness params, and fans out NUTS3 regions via resolveRegion', async () => {
            await withFrozenClock(frozenNow, async () => {
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
                                        {
                                            areaDesc: 'Skopje region',
                                            geocode: [],
                                        },
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
                assert.match(firstAlert.externalId, /^[0-9a-f]{32}$/);
                assert.equal(firstAlert.locationLabel, 'Аеродром');
                assert.equal(firstAlert.title, 'Грмежи и невреме: Аеродром');
                assert.equal(firstAlert.status, 'ongoing');
                assert.doesNotMatch(present(firstAlert.description), /\?\?\?/);

                const secondAlert = at(parsed, 1);
                assert.match(secondAlert.externalId, /^[0-9a-f]{32}$/);
                assert.equal(secondAlert.locationLabel, 'Гази Баба');
                assert.equal(secondAlert.title, 'Грмежи и невреме: Гази Баба');

                const rePushed = await strategy.parse([
                    at(raw, 0),
                    {
                        uuid: 'u-2',
                        alert: { ...at(raw, 0).alert, identifier: 'ALERT-2' },
                    },
                ]);
                assert.equal(rePushed.length, 4);
                assert.equal(at(rePushed, 0).externalId, firstAlert.externalId);
                assert.equal(
                    at(rePushed, 1).externalId,
                    secondAlert.externalId,
                );
                assert.equal(at(rePushed, 2).externalId, firstAlert.externalId);
                assert.equal(
                    at(rePushed, 3).externalId,
                    secondAlert.externalId,
                );

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
                assert.match(at(infoFallback, 0).externalId, /^[0-9a-f]{32}$/);

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
                                    expires: new Date(
                                        effectiveTime.getTime() - 1,
                                    ),
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
                    assert.ok(
                        at(coloredAlert, 0).title.startsWith('Густа магла'),
                    );
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
                    assert.ok(
                        at(translated, 0).title.startsWith(expectedTitle),
                    );
                }
            });
        });
    });
});
