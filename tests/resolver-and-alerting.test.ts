import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { config } from '../src/core/config.js';
import type { EventItem, ReportItem } from '../src/core/schema.js';
import type { AlertChannel } from '../src/infrastructure/alerting/channel.interface.js';
import { DiscordChannel } from '../src/infrastructure/alerting/channels/discord.channel.js';
import { AlertDispatcher } from '../src/infrastructure/alerting/dispatcher.js';
import type { DbOrTx } from '../src/infrastructure/database/db.js';
import { MunicipalityResolver } from '../src/modules/scraping/resolver.js';
import { at, present } from './test-utils.js';

type DiscordEmbedPayload = {
    title: string;
    description?: string;
    color: number;
    timestamp: string;
    fields: Array<{ name: string; value: string }>;
};

type DiscordWebhookPayload = {
    username: string;
    embeds: DiscordEmbedPayload[];
};

function createResolverDb() {
    const rows = [
        {
            code: 'MK0080907',
            nameMk: 'Карпош',
            nameEn: 'Karposh',
            regionCode: 'MK008',
        },
        {
            code: 'MK0080904',
            nameMk: 'Гази Баба',
            nameEn: 'Gazi Baba',
            regionCode: 'MK008',
        },
        {
            code: 'MK0080999',
            nameMk: 'Гази Баба Центар',
            nameEn: 'Gazi Baba Center',
            regionCode: 'MK008',
        },
    ];
    let selectCount = 0;
    let coordinateRows: Array<{ code: string; name: string }> = [];

    const db = {
        select: () => ({
            from: () => {
                const isInitQuery = selectCount++ === 0;
                if (isInitQuery) return Promise.resolve(rows);
                return {
                    where: () => ({ limit: async () => coordinateRows }),
                };
            },
        }),
    } as unknown as DbOrTx;

    return {
        db,
        get selectCount() {
            return selectCount;
        },
        setCoordinateRows(value: Array<{ code: string; name: string }>) {
            coordinateRows = value;
        },
    };
}

describe('MunicipalityResolver', () => {
    it('loads normalized aliases once and resolves exact, segment, substring, and region matches', async () => {
        const mock = createResolverDb();
        const resolver = new MunicipalityResolver(mock.db);
        await resolver.init();
        await resolver.init();

        assert.equal(mock.selectCount, 1);
        assert.equal(resolver.resolveText('Карпош'), 'MK0080907');
        assert.equal(resolver.resolveText('karposh'), 'MK0080907');
        assert.equal(resolver.resolveText('АЕРОДРОМ - ГАЗИ БАБА'), 'MK0080904');
        assert.equal(
            resolver.resolveText('адреса кај Гази Баба Центар'),
            'MK0080999',
        );
        assert.equal(resolver.resolveText('непозната локација'), null);
        assert.equal(resolver.resolveText('   '), null);
        assert.equal(resolver.resolveText(null), null);
        assert.deepEqual(resolver.resolveRegion(' mk008 '), [
            { code: 'MK0080907', nameMk: 'Карпош' },
            { code: 'MK0080904', nameMk: 'Гази Баба' },
            { code: 'MK0080999', nameMk: 'Гази Баба Центар' },
        ]);
        assert.deepEqual(resolver.resolveRegion('unknown'), []);
    });

    it('validates coordinates and memoizes coordinate hits and misses', async () => {
        const mock = createResolverDb();
        const resolver = new MunicipalityResolver(mock.db);
        await resolver.init();
        const afterInit = mock.selectCount;

        assert.equal(await resolver.resolveCoords(null, 42), null);
        assert.equal(await resolver.resolveCoords(Number.NaN, 42), null);
        assert.equal(mock.selectCount, afterInit);

        mock.setCoordinateRows([{ code: 'MK0080907', name: 'Карпош' }]);
        assert.deepEqual(await resolver.resolveCoords(21.42, 42), {
            code: 'MK0080907',
            name: 'Карпош',
        });
        assert.deepEqual(await resolver.resolveCoords(21.42, 42), {
            code: 'MK0080907',
            name: 'Карпош',
        });
        assert.equal(mock.selectCount, afterInit + 1);

        mock.setCoordinateRows([]);
        assert.equal(await resolver.resolveCoords(21.43, 42), null);
        assert.equal(await resolver.resolveCoords(21.43, 42), null);
        assert.equal(mock.selectCount, afterInit + 2);
    });
});

function alertItem(
    overrides: Record<string, unknown> = {},
    includeLocation = true,
) {
    return {
        id: 1,
        externalId: 'e-1',
        source: 'test',
        category: 'water',
        title: 'A title'.repeat(40),
        description: 'A description'.repeat(400),
        status: 'ongoing',
        observedAt: new Date('2026-10-25T00:00:00.000Z'),
        startsAt: new Date('2026-10-25T01:00:00.000Z'),
        endsAt: new Date('2026-10-25T02:00:00.000Z'),
        ...(includeLocation ? { locationLabel: 'Карпош' } : {}),
        ...overrides,
    } as unknown as ReportItem | EventItem;
}

describe('Alerting', () => {
    it('initializes configured Discord channels from runtime config', async () => {
        const originalUrls = [...config.DISCORD_WEBHOOK_URLS];
        const originalFetch = globalThis.fetch;
        const postedUrls: string[] = [];
        config.DISCORD_WEBHOOK_URLS.splice(
            0,
            config.DISCORD_WEBHOOK_URLS.length,
            'https://discord.test/init-hook',
        );
        globalThis.fetch = (async (input) => {
            postedUrls.push(String(input));
            return new Response(null, { status: 204 });
        }) as typeof fetch;
        try {
            const dispatcher = new AlertDispatcher();
            await dispatcher.init();
            await dispatcher.dispatch('test', [alertItem()]);
            assert.deepEqual(postedUrls, ['https://discord.test/init-hook']);
        } finally {
            config.DISCORD_WEBHOOK_URLS.splice(
                0,
                config.DISCORD_WEBHOOK_URLS.length,
                ...originalUrls,
            );
            globalThis.fetch = originalFetch;
        }
    });

    it('builds Discord embeds, batches at 10, and rejects failed webhook responses', async () => {
        const originalFetch = globalThis.fetch;
        const requests: Array<{ url: string; body: DiscordWebhookPayload }> =
            [];
        globalThis.fetch = (async (input, init) => {
            requests.push({
                url: String(input),
                body: JSON.parse(String(init?.body)) as DiscordWebhookPayload,
            });
            return new Response(null, { status: 204 });
        }) as typeof fetch;

        try {
            const channel = new DiscordChannel('https://discord.test/webhook');
            await channel.send(
                Array.from({ length: 11 }, (_, index) =>
                    alertItem({ id: index }),
                ),
            );
            assert.equal(requests.length, 2);
            assert.equal(at(requests, 0).url, 'https://discord.test/webhook');
            assert.equal(at(requests, 0).body.username, 'glb::relay');
            const firstEmbeds = at(requests, 0).body.embeds;
            assert.equal(firstEmbeds.length, 10);
            assert.equal(at(requests, 1).body.embeds.length, 1);
            const firstEmbed = at(firstEmbeds, 0);
            assert.equal(firstEmbed.title.length, 253);
            assert.equal(present(firstEmbed.description).length, 4096);
            assert.equal(firstEmbed.color, 0xe74c3c);
            assert.match(firstEmbed.timestamp, /^2026-/);
            const fields = firstEmbed.fields;
            assert.deepEqual(
                fields.map((field) => field.name),
                ['Извор', 'Статус', 'Локација', 'Почеток', 'Крај'],
            );
            assert.match(at(fields, 3).value, /<t:\d+:f>/);

            globalThis.fetch = (async () =>
                new Response('rate limited', { status: 429 })) as typeof fetch;
            await assert.rejects(
                channel.send([alertItem()]),
                /Webhook request failed with status code 429: rate limited/,
            );
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    it('omits report-only fields for events and maps unknown status/category to fallbacks', async () => {
        const originalFetch = globalThis.fetch;
        let payload: DiscordWebhookPayload | undefined;
        globalThis.fetch = (async (_input, init) => {
            payload = JSON.parse(String(init?.body)) as DiscordWebhookPayload;
            return new Response(null, { status: 204 });
        }) as typeof fetch;
        try {
            const event = alertItem(
                {
                    category: 'unexpected',
                    status: 'unknown',
                    description: null,
                    startsAt: null,
                    endsAt: null,
                },
                false,
            );
            await new DiscordChannel('https://discord.test').send([event]);
            const embed = at(present(payload).embeds, 0);
            assert.match(embed.title, /^📢 /);
            assert.equal(embed.color, 0x95a5a6);
            assert.equal(embed.description, undefined);
            assert.deepEqual(
                embed.fields.map((field) => field.name),
                ['Извор', 'Статус'],
            );
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    it('maps every supported Discord category and lifecycle status', async () => {
        const originalFetch = globalThis.fetch;
        let payload: DiscordWebhookPayload | undefined;
        globalThis.fetch = (async (_input, init) => {
            payload = JSON.parse(String(init?.body)) as DiscordWebhookPayload;
            return new Response(null, { status: 204 });
        }) as typeof fetch;
        try {
            const categories = [
                'fuel_price',
                'currency_exchange',
                'power',
                'water',
                'road',
                'weather',
                'wildfire',
                'air_quality',
            ];
            const statuses = ['ongoing', 'scheduled', 'ended', 'unknown'];
            const expectedEmoji = [
                '⛽',
                '💱',
                '⚡',
                '💧',
                '🚧',
                '🌩️',
                '🔥',
                '💨',
            ];
            const expectedColor = [0xe74c3c, 0xf39c12, 0x2ecc71, 0x95a5a6];
            const items = categories.map((category, index) =>
                alertItem({
                    category,
                    status: statuses[index % statuses.length],
                }),
            );
            await new DiscordChannel('https://discord.test').send(items);
            const embeds = present(payload).embeds;
            for (const [index, emoji] of expectedEmoji.entries()) {
                assert.ok(at(embeds, index).title.startsWith(emoji));
            }
            assert.deepEqual(
                embeds.map((embed) => embed.color),
                categories.map(
                    (_, index) => expectedColor[index % expectedColor.length],
                ),
            );
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    it('dispatcher skips empty dispatches and isolates per-channel failures', async () => {
        const emptyDispatcher = new AlertDispatcher();
        await emptyDispatcher.dispatch('test', [alertItem()]);

        const dispatcher = new AlertDispatcher() as unknown as {
            channels: AlertChannel[];
            dispatch: AlertDispatcher['dispatch'];
        };
        let delivered = 0;
        dispatcher.channels.push(
            {
                name: 'broken',
                send: async () => {
                    throw new Error('channel offline');
                },
            },
            {
                name: 'healthy',
                send: async () => {
                    delivered++;
                },
            },
        );
        await dispatcher.dispatch('test', []);
        assert.equal(delivered, 0);
        await dispatcher.dispatch('test', [alertItem()]);
        assert.equal(delivered, 1);
    });
});
