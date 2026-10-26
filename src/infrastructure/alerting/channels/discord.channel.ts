import { setTimeout } from 'node:timers/promises';
import type { AlertChannel, AlertItem } from '../channel.interface.js';

export class DiscordChannel implements AlertChannel {
    readonly name = 'discord';
    private readonly webhookUrl: string;

    constructor(webhookUrl: string) {
        this.webhookUrl = webhookUrl;
    }

    async send(items: AlertItem[]): Promise<void> {
        const batchSize = 10;

        for (let i = 0; i < items.length; i += batchSize) {
            const chunk = items.slice(i, i + batchSize);
            const embeds = chunk.map((item) => this.buildEmbed(item));

            const response = await fetch(this.webhookUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    username: 'glb::relay',
                    embeds,
                }),
                signal: AbortSignal.timeout(15_000),
            });

            if (!response.ok) {
                const errorText = await response.text();

                throw new Error(
                    `Webhook request failed with status code ${response.status}: ${errorText}`,
                );
            }

            if (i + batchSize < items.length) {
                await setTimeout(500);
            }
        }
    }

    private buildEmbed(item: AlertItem) {
        const statusMeta = this.getStatusMeta(item.status);
        const categoryEmoji = this.getCategoryEmoji(item.category);
        const location =
            'locationLabel' in item && item.locationLabel
                ? item.locationLabel
                : null;

        const fields = [
            {
                name: 'Извор',
                value: item.source,
                inline: true,
            },
            {
                name: 'Статус',
                value: statusMeta.label,
                inline: true,
            },
        ];

        if (location) {
            fields.push({
                name: 'Локација',
                value: location,
                inline: true,
            });
        }

        if (item.startsAt) {
            fields.push({
                name: 'Почеток',
                value: this.formatDiscordTime(item.startsAt),
                inline: true,
            });
        }

        if (item.endsAt) {
            fields.push({
                name: 'Крај',
                value: this.formatDiscordTime(item.endsAt),
                inline: true,
            });
        }

        return {
            title: `${categoryEmoji} ${this.truncate(item.title, 250)}`,
            description: item.description
                ? this.truncate(item.description, 4096)
                : undefined,
            color: statusMeta.color,
            fields,
            footer: {
                text: `glb::relay`,
            },
            timestamp: item.observedAt.toISOString(),
        };
    }

    private formatDiscordTime(date: Date): string {
        const unix = Math.floor(date.getTime() / 1000);
        return `<t:${unix}:f>\n(<t:${unix}:R>)`;
    }

    private truncate(text: string, maxLength: number): string {
        if (text.length <= maxLength) return text;
        return `${text.slice(0, maxLength - 3)}...`;
    }

    private getStatusMeta(status: AlertItem['status']): {
        color: number;
        label: string;
    } {
        switch (status) {
            case 'ongoing':
                return { color: 0xe74c3c, label: 'Во тек' };
            case 'scheduled':
                return { color: 0xf39c12, label: 'Најавено' };
            case 'ended':
                return { color: 0x2ecc71, label: 'Завршено' };
            default:
                return { color: 0x95a5a6, label: 'Непознато' };
        }
    }

    private getCategoryEmoji(category: string): string {
        switch (category) {
            case 'fuel_price':
                return '⛽';
            case 'currency_exchange':
                return '💱';
            case 'power':
                return '⚡';
            case 'water':
                return '💧';
            case 'road':
                return '🚧';
            case 'weather':
                return '🌩️';
            case 'wildfire':
                return '🔥';
            case 'air_quality':
                return '💨';
            case 'earthquake':
                return '🌍';
            default:
                return '📢';
        }
    }
}
