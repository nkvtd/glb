import { config } from '../../core/config.js';
import { logger } from '../logging/logger.js';
import type { AlertChannel, AlertItem } from './channel.interface.js';
import { DiscordChannel } from './channels/discord.channel.js';

export class AlertDispatcher {
    private readonly channels: AlertChannel[] = [];

    async init(): Promise<void> {
        this.channels.length = 0;

        for (const url of config.DISCORD_WEBHOOK_URLS) {
            this.channels.push(new DiscordChannel(url));
        }

        // Open for more optional channels:
        // e.g.,for (const url of config.SLACK_WEBHOOK_URLS) { ... }

        const names = this.channels.map((c) => c.name).join(', ');
        logger.info(
            `[Dispatcher] initialized with ${this.channels.length} channel(s)${names ? `: (${names})` : '.'}`,
        );
    }

    async dispatch(sourceLabel: string, items: AlertItem[]): Promise<void> {
        if (items.length === 0 || this.channels.length === 0) return;

        for (const channel of this.channels) {
            try {
                logger.info(
                    `[Dispatcher:${sourceLabel}:${channel.name}] dispatching ${items.length} alert(s)...`,
                );
                await channel.send(items);
            } catch (error) {
                logger.error(
                    `[Dispatcher:${sourceLabel}:${channel.name}] alert dispatch failed:\n%O`,
                    error,
                );
            }
        }
    }
}
