import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { config } from '../src/core/config.js';
import type { AlertChannel } from '../src/infrastructure/alerting/channel.interface.js';
import { DiscordChannel } from '../src/infrastructure/alerting/channels/discord.channel.js';
import { AlertDispatcher } from '../src/infrastructure/alerting/dispatcher.js';
import { at, present } from './util/assertions.js';
import { alertItem } from './util/fakes.js';
import { emptyResponse, textResponse, withFetch } from './util/fetch-mock.js';

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

describe('Alerting', () => {
    it('initializes configured Discord channels from runtime config', async () => {
        const originalUrls = [...config.DISCORD_WEBHOOK_URLS];
        const postedUrls: string[] = [];
        config.DISCORD_WEBHOOK_URLS.splice(
            0,
            config.DISCORD_WEBHOOK_URLS.length,
            'https://discord.test/init-hook',
        );
        try {
            const dispatcher = new AlertDispatcher();
            await withFetch(
                (async (input) => {
                    postedUrls.push(String(input));
                    return emptyResponse();
                }) as typeof fetch,
                async () => {
                    await dispatcher.init();
                    await dispatcher.dispatch('test', [alertItem()]);
                },
            );
            assert.deepEqual(postedUrls, ['https://discord.test/init-hook']);
        } finally {
            config.DISCORD_WEBHOOK_URLS.splice(
                0,
                config.DISCORD_WEBHOOK_URLS.length,
                ...originalUrls,
            );
        }
    });

    it('builds Discord embeds, batches at 10, and rejects failed webhook responses', async () => {
        const requests: Array<{ url: string; body: DiscordWebhookPayload }> =
            [];
        const channel = new DiscordChannel('https://discord.test/webhook');

        await withFetch(
            (async (input, init) => {
                requests.push({
                    url: String(input),
                    body: JSON.parse(
                        String(init?.body),
                    ) as DiscordWebhookPayload,
                });
                return emptyResponse();
            }) as typeof fetch,
            async () => {
                await channel.send(
                    Array.from({ length: 11 }, (_, index) =>
                        alertItem({ id: index }),
                    ),
                );
            },
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
            ['Извор', 'Локација', '\u200b', 'Почеток', 'Крај'],
        );
        assert.match(at(fields, 3).value, /<t:\d+:f>/);

        await withFetch(
            (async () => textResponse('rate limited', 429)) as typeof fetch,
            async () => {
                await assert.rejects(
                    channel.send([alertItem()]),
                    /Webhook request failed with status code 429: rate limited/,
                );
            },
        );
    });

    it('builds a single-field embed for location-less events with unknown categories', async () => {
        let payload: DiscordWebhookPayload | undefined;
        await withFetch(
            (async (_input, init) => {
                payload = JSON.parse(
                    String(init?.body),
                ) as DiscordWebhookPayload;
                return emptyResponse();
            }) as typeof fetch,
            async () => {
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
            },
        );
        const embed = at(present(payload).embeds, 0);
        assert.match(embed.title, /^📢 /);
        assert.equal(embed.color, 0xe74c3c);
        assert.equal(embed.description, undefined);
        assert.deepEqual(
            embed.fields.map((field) => field.name),
            ['Извор'],
        );
        assert.ok(
            embed.fields.every((field) => typeof field.value === 'string'),
        );
    });

    it('maps every supported Discord category emoji', async () => {
        let payload: DiscordWebhookPayload | undefined;
        const categories = [
            'fuel_price',
            'currency_exchange',
            'power',
            'water',
            'road',
            'weather',
            'wildfire',
            'air_quality',
            'earthquake',
            'internet',
        ];
        const expectedEmoji = [
            '⛽',
            '💱',
            '⚡',
            '💧',
            '🚧',
            '🌩️',
            '🔥',
            '💨',
            '🌍',
            '🛜',
        ];
        const items = categories.map((category) => alertItem({ category }));

        await withFetch(
            (async (_input, init) => {
                payload = JSON.parse(
                    String(init?.body),
                ) as DiscordWebhookPayload;
                return emptyResponse();
            }) as typeof fetch,
            async () => {
                await new DiscordChannel('https://discord.test').send(items);
            },
        );

        const embeds = present(payload).embeds;
        for (const [index, emoji] of expectedEmoji.entries()) {
            assert.ok(at(embeds, index).title.startsWith(emoji));
        }
        assert.deepEqual(
            embeds.map((embed) => embed.color),
            categories.map(() => 0xe74c3c),
        );
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
