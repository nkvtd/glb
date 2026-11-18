import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { vodovodSkopjeResponseSchema } from '../src/core/validation/vodovod-skopje.js';
import { EvnStrategy } from '../src/modules/scraping/strategies/evn.strategy.js';
import { MeteoalarmStrategy } from '../src/modules/scraping/strategies/meteoalarm.strategy.js';
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
import { alert, kumanovoPost, prilepPost } from './util/fixtures.js';

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
