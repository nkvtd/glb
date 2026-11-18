import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';
import type { IodaSignalSeries } from '../src/core/validation/ioda.js';
import {
    getAirQualityAdjective,
    getAirQualityTitlePrefix,
    POOR_AIR_INDEX_CODES,
} from '../src/modules/scraping/strategies/util/air-quality.js';
import {
    BROWSER_JSON_HEADERS,
    fetchJson,
    fetchJsonOrNull,
} from '../src/modules/scraping/strategies/util/fetch.js';
import { formatEwktPoint } from '../src/modules/scraping/strategies/util/geo.js';
import { hashExternalId } from '../src/modules/scraping/strategies/util/hash.js';
import {
    computeIodaAvailabilityPct,
    flattenIodaSignals,
    latestIodaTimestamp,
    metricForIodaSeries,
} from '../src/modules/scraping/strategies/util/ioda.js';
import {
    mean,
    median,
    trimmedMean,
} from '../src/modules/scraping/strategies/util/math.js';
import {
    capitalizeFirst,
    decodeHtmlText,
    ensurePeriod,
    formatDecimalComma,
    formatPercentComma,
    toTitleCase,
} from '../src/modules/scraping/strategies/util/text.js';
import {
    buildLocalWindow,
    deriveLifecycleStatus,
    extractIsoDay,
    floorToUtcHourIso,
    formatLocalDate,
    getLocalOffset,
    parseLocalMidnight,
} from '../src/modules/scraping/strategies/util/time.js';

const numberSchema = z.object({ value: z.number() });

function jsonResponse(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'content-type': 'application/json' },
    });
}

async function withFetchMock(
    mock: typeof globalThis.fetch,
    run: () => Promise<unknown>,
): Promise<unknown> {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock;
    try {
        return await run();
    } finally {
        globalThis.fetch = originalFetch;
    }
}

function makeSeries(
    values: Array<number | null>,
    from = 0,
    step = 100,
    datasource = 'bgp',
): IodaSignalSeries {
    return {
        entityType: 'country',
        entityCode: 'MK',
        entityName: 'Macedonia',
        datasource,
        from,
        until: from + values.length * step,
        step,
        values,
    };
}

describe('scraping util: http', () => {
    it('exposes browser-like JSON headers', () => {
        assert.deepStrictEqual(
            { ...BROWSER_JSON_HEADERS },
            {
                Accept: 'application/json',
                'User-Agent':
                    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            },
        );
    });

    it('parses JSON and injects no default method, headers, or body', async () => {
        let capturedInit: RequestInit | undefined;
        const result = await withFetchMock(
            (_input, init) => {
                capturedInit = init;
                return Promise.resolve(jsonResponse({ value: 42 }));
            },
            () => fetchJson('https://example.test/data', numberSchema),
        );
        assert.deepStrictEqual(result, { value: 42 });
        assert.strictEqual(capturedInit?.method, undefined);
        assert.strictEqual(capturedInit?.headers, undefined);
        assert.strictEqual(capturedInit?.body, undefined);
        assert.ok(capturedInit?.signal instanceof AbortSignal);
    });

    it('forwards method, headers, and body when provided', async () => {
        let capturedInit: RequestInit | undefined;
        const body = JSON.stringify({ query: 'latest' });
        const result = await withFetchMock(
            (_input, init) => {
                capturedInit = init;
                return Promise.resolve(jsonResponse({ value: 7 }));
            },
            () =>
                fetchJson('https://example.test/data', numberSchema, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body,
                }),
        );
        assert.deepStrictEqual(result, { value: 7 });
        assert.strictEqual(capturedInit?.method, 'POST');
        assert.deepStrictEqual(capturedInit?.headers, {
            'Content-Type': 'application/json',
        });
        assert.strictEqual(capturedInit?.body, body);
    });

    it('throws the upstream status code and body on non-OK responses', async () => {
        await assert.rejects(
            withFetchMock(
                () =>
                    Promise.resolve(
                        new Response('upstream down', { status: 503 }),
                    ),
                () => fetchJson('https://example.test/data', numberSchema),
            ),
            (error: unknown) =>
                error instanceof Error &&
                error.message ===
                    'Fetch failed with status code 503: upstream down',
        );
    });

    it('rejects HTML error pages when rejectHtml is enabled', async () => {
        const htmlResponse = new Response('<html>Service unavailable</html>', {
            status: 200,
            headers: { 'content-type': 'text/html; charset=utf-8' },
        });
        await assert.rejects(
            withFetchMock(
                () => Promise.resolve(htmlResponse),
                () =>
                    fetchJson('https://example.test/data', numberSchema, {
                        rejectHtml: true,
                    }),
            ),
            (error: unknown) =>
                error instanceof Error &&
                error.message ===
                    'Fetch returned an HTML error page: <html>Service unavailable</html>',
        );
    });

    it('rejects when the request exceeds the timeout', async () => {
        await assert.rejects(
            withFetchMock(
                (_input, init) =>
                    new Promise<Response>((_resolve, reject) => {
                        const signal = init?.signal;
                        signal?.addEventListener('abort', () => {
                            reject(signal.reason ?? new Error('aborted'));
                        });
                    }),
                () =>
                    fetchJson('https://example.test/slow', numberSchema, {
                        timeoutMs: 50,
                    }),
            ),
            (error: unknown) => error instanceof Error,
        );
    });

    it('returns null on 204 No Content', async () => {
        const result = await withFetchMock(
            () => Promise.resolve(new Response(null, { status: 204 })),
            () => fetchJsonOrNull('https://example.test/data', numberSchema),
        );
        assert.strictEqual(result, null);
    });

    it('parses JSON for non-204 responses', async () => {
        const result = await withFetchMock(
            () => Promise.resolve(jsonResponse({ value: 3 })),
            () => fetchJsonOrNull('https://example.test/data', numberSchema),
        );
        assert.deepStrictEqual(result, { value: 3 });
    });
});

describe('scraping util: hash', () => {
    it('produces a deterministic 32-char hex id from joined parts', () => {
        const id = hashExternalId('evn', 123, 'Лисиче');
        assert.match(id, /^[0-9a-f]{32}$/);
        assert.strictEqual(id, hashExternalId('evn', 123, 'Лисиче'));
        assert.notStrictEqual(id, hashExternalId('evn', 124, 'Лисиче'));
    });
});

describe('scraping util: time', () => {
    it('formats the local calendar day across midnight UTC', () => {
        assert.strictEqual(
            formatLocalDate(new Date('2026-01-15T12:30:00Z')),
            '2026-01-15',
        );
        assert.strictEqual(
            formatLocalDate(new Date('2026-01-15T23:30:00Z')),
            '2026-01-16',
        );
    });

    it('resolves the local offset for winter and DST summer probes', () => {
        assert.strictEqual(
            getLocalOffset(new Date('2026-01-15T12:00:00Z')),
            '+01:00',
        );
        assert.strictEqual(
            getLocalOffset(new Date('2026-07-15T12:00:00Z')),
            '+02:00',
        );
    });

    it('extracts the leading ISO day', () => {
        assert.strictEqual(
            extractIsoDay('  2026-03-05T10:00:00'),
            '2026-03-05',
        );
        assert.strictEqual(extractIsoDay('no date here'), null);
    });

    it('parses local midnight in winter and summer', () => {
        assert.strictEqual(
            parseLocalMidnight('2026-01-15').toISOString(),
            '2026-01-14T23:00:00.000Z',
        );
        assert.strictEqual(
            parseLocalMidnight('2026-07-15').toISOString(),
            '2026-07-14T22:00:00.000Z',
        );
    });

    it('builds local windows with per-side offsets', () => {
        const winter = buildLocalWindow('2026-01-15', 8, 0, 14, 30);
        assert.ok(winter);
        assert.strictEqual(
            winter.startsAt.toISOString(),
            '2026-01-15T07:00:00.000Z',
        );
        assert.strictEqual(
            winter.endsAt.toISOString(),
            '2026-01-15T13:30:00.000Z',
        );

        const summer = buildLocalWindow('2026-07-15', 8, 0, 23, 59, 59, 999);
        assert.ok(summer);
        assert.strictEqual(
            summer.startsAt.toISOString(),
            '2026-07-15T06:00:00.000Z',
        );
        assert.strictEqual(
            summer.endsAt.toISOString(),
            '2026-07-15T21:59:59.999Z',
        );

        assert.strictEqual(buildLocalWindow('not-a-day', 8, 0, 14, 30), null);
    });

    it('floors dates to the UTC hour', () => {
        assert.strictEqual(
            floorToUtcHourIso(new Date('2026-03-05T10:45:30.500Z')),
            '2026-03-05T10:00:00Z',
        );
    });

    it('derives lifecycle status', () => {
        const startsAt = new Date('2026-01-15T08:00:00Z');
        const endsAt = new Date('2026-01-15T14:00:00Z');

        assert.strictEqual(
            deriveLifecycleStatus(
                new Date('2026-01-15T09:00:00Z'),
                startsAt,
                endsAt,
                { closed: true },
            ),
            'ended',
        );
        assert.strictEqual(
            deriveLifecycleStatus(
                new Date('2026-01-15T07:59:00Z'),
                startsAt,
                endsAt,
            ),
            'scheduled',
        );
        assert.strictEqual(
            deriveLifecycleStatus(
                new Date('2026-01-15T09:00:00Z'),
                startsAt,
                endsAt,
            ),
            'ongoing',
        );
        assert.strictEqual(
            deriveLifecycleStatus(endsAt, startsAt, endsAt),
            'ongoing',
        );
        assert.strictEqual(
            deriveLifecycleStatus(
                new Date('2026-01-15T14:00:00.001Z'),
                startsAt,
                endsAt,
            ),
            'ended',
        );
        assert.strictEqual(
            deriveLifecycleStatus(endsAt, startsAt, endsAt, {
                inclusiveEnd: false,
            }),
            'ended',
        );
        assert.strictEqual(
            deriveLifecycleStatus(
                new Date('2026-01-15T13:59:59.999Z'),
                startsAt,
                endsAt,
                { inclusiveEnd: false },
            ),
            'ongoing',
        );
        assert.strictEqual(
            deriveLifecycleStatus(
                new Date('2026-01-15T07:59:00Z'),
                startsAt,
                null,
            ),
            'scheduled',
        );
        assert.strictEqual(
            deriveLifecycleStatus(
                new Date('2026-01-15T20:00:00Z'),
                startsAt,
                null,
            ),
            'ongoing',
        );
    });
});

describe('scraping util: text', () => {
    it('capitalizes the first character', () => {
        assert.strictEqual(capitalizeFirst('ден'), 'Ден');
        assert.strictEqual(capitalizeFirst(''), '');
    });

    it('title-cases with optional short-word uppercasing', () => {
        assert.strictEqual(toTitleCase('КАРПОШ'), 'Карпош');
        assert.strictEqual(
            toTitleCase('ск поправка на ск'),
            'Ск Поправка На Ск',
        );
        assert.strictEqual(
            toTitleCase('ск поправка на ск', { uppercaseShortWords: true }),
            'СК Поправка НА СК',
        );
    });

    it('ensures exactly one trailing period', () => {
        assert.strictEqual(ensurePeriod('Вода без крај'), 'Вода без крај.');
        assert.strictEqual(ensurePeriod('Со точка.'), 'Со точка.');
        assert.strictEqual(ensurePeriod('Повеќе...'), 'Повеќе.');
    });

    it('formats decimals and percents with comma separators', () => {
        assert.strictEqual(formatDecimalComma(61.7234, 4), '61,7234');
        assert.strictEqual(formatPercentComma(99.5), '99,5%');
        assert.strictEqual(formatPercentComma(100), '100%');
    });

    it('strips tags, decodes entities, and normalizes spacing', () => {
        assert.strictEqual(
            decodeHtmlText('<b>Вода</b>&nbsp;( утро ) ,&amp;more'),
            'Вода (утро), &more',
        );
        assert.strictEqual(decodeHtmlText('цена 3,5 л'), 'цена 3,5 л');
        assert.strictEqual(decodeHtmlText('&ndash;&hellip;&#8222;'), '–..."');
    });
});

describe('scraping util: math', () => {
    it('computes means', () => {
        assert.strictEqual(mean([1, 2, 3]), 2);
        assert.strictEqual(mean([]), null);
    });

    it('trims extremes only once there are at least four samples', () => {
        assert.strictEqual(trimmedMean([1, 2, 3]), 2);
        assert.strictEqual(trimmedMean([10, 1, 1, 1, 1, 1, 100]), 2.8);
        assert.strictEqual(
            trimmedMean([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.3),
            5.5,
        );
    });

    it('computes medians rounded to one decimal', () => {
        assert.strictEqual(median([5, 1, 3]), 3);
        assert.strictEqual(median([1, 2, 3, 4]), 2.5);
        assert.strictEqual(median([]), 0);
    });
});

describe('scraping util: geo', () => {
    it('formats PostGIS EWKT points', () => {
        assert.strictEqual(
            formatEwktPoint(21.4254, 42.0021),
            'SRID=4326;POINT(21.4254 42.0021)',
        );
    });
});

describe('scraping util: air-quality', () => {
    it('flags poor air index codes', () => {
        assert.ok(POOR_AIR_INDEX_CODES.has('04'));
        assert.ok(!POOR_AIR_INDEX_CODES.has('01'));
    });

    it('maps codes to title prefixes with fallback', () => {
        assert.strictEqual(
            getAirQualityTitlePrefix('01'),
            'Добар квалитет на воздух',
        );
        assert.strictEqual(
            getAirQualityTitlePrefix(undefined),
            'Квалитет на воздух (нема податоци)',
        );
        assert.strictEqual(
            getAirQualityTitlePrefix('99', 'Квалитет на воздух'),
            'Квалитет на воздух',
        );
    });

    it('maps codes to adjectives', () => {
        assert.strictEqual(getAirQualityAdjective('04'), 'лош');
        assert.strictEqual(getAirQualityAdjective('07'), null);
        assert.strictEqual(getAirQualityAdjective(undefined), null);
    });
});

describe('scraping util: ioda', () => {
    it('flattens nested signal arrays and rejects error bodies', () => {
        const first = makeSeries([1, 2]);
        const second = makeSeries([3], 500, 10, 'ping-slash24');
        assert.deepStrictEqual(
            flattenIodaSignals({ error: null, data: [[first], [second]] }),
            [first, second],
        );
        assert.deepStrictEqual(
            flattenIodaSignals({ error: null, data: null }),
            [],
        );
        assert.throws(
            () => flattenIodaSignals({ error: 'boom', data: null }),
            (error: unknown) =>
                error instanceof Error &&
                error.message === 'IODA request failed: boom',
        );
    });

    it('derives the latest metric from signal series', () => {
        assert.deepStrictEqual(
            metricForIodaSeries([makeSeries([100, 100, 50])]),
            {
                current: 50,
                baseline: 100,
                ratio: 0.5,
            },
        );
        assert.strictEqual(metricForIodaSeries([makeSeries([0, 0])]), null);
        assert.strictEqual(metricForIodaSeries([]), null);
    });

    it('finds the newest valid sample timestamp', () => {
        assert.strictEqual(
            latestIodaTimestamp([
                makeSeries([1, null, 3], 1000, 100),
                makeSeries([5], 500, 10),
            ]),
            1200,
        );
        assert.strictEqual(
            latestIodaTimestamp([makeSeries([null, null])]),
            null,
        );
        assert.strictEqual(latestIodaTimestamp([]), null);
    });

    it('blends BGP and ping ratios and honours the BGP floor', () => {
        const bgp = { current: 80, baseline: 100, ratio: 0.8 };
        const weakBgp = { current: 63, baseline: 7, ratio: 0.9 };
        const ping = { current: 8, baseline: 20, ratio: 0.4 };

        assert.strictEqual(computeIodaAvailabilityPct(bgp, ping, 10), 68);
        assert.strictEqual(computeIodaAvailabilityPct(null, null, 10), 0);
        // baseline 7 is below the floor of 10, so only ping counts
        assert.strictEqual(computeIodaAvailabilityPct(weakBgp, ping, 10), 40);
        // with a floor of 5 both signals blend
        assert.strictEqual(computeIodaAvailabilityPct(weakBgp, ping, 5), 75);
        assert.strictEqual(
            computeIodaAvailabilityPct(
                { current: 150, baseline: 100, ratio: 1.5 },
                null,
                10,
            ),
            100,
        );
    });
});
