import type { AmsmFuelEventInsert } from '../../../core/types/amsm-fuel.js';
import {
    type AmsmFuelAcf,
    type AmsmFuelItem,
    amsmFuelResponseSchema,
} from '../../../core/validation/amsm-fuel.js';
import type { ScrapingStrategy } from '../strategy.interface.js';
import { fetchJson } from './util/fetch.js';
import { hashExternalId } from './util/hash.js';

export class AmsmFuelStrategy
    implements ScrapingStrategy<AmsmFuelItem[], AmsmFuelEventInsert>
{
    readonly source = 'amsm-fuel';
    readonly url: string;
    readonly category = 'fuel_price' as const;
    readonly target = 'events';
    readonly schedule: string;
    readonly stateFeed = true;

    constructor(url: string, schedule: string) {
        this.url = url;
        this.schedule = schedule;
    }

    async fetch(): Promise<AmsmFuelItem[]> {
        return fetchJson(this.url, amsmFuelResponseSchema);
    }

    async parse(items: AmsmFuelItem[]): Promise<AmsmFuelEventInsert[]> {
        const now = new Date();

        return items.map((item) => {
            const { acf } = item;

            const p95 = this.formatMkd(acf.petrol95);
            const p98 = this.formatMkd(acf.petrol98);
            const diesel = this.formatMkd(acf.diesel);
            const lastUpdateRaw = acf.gas_last_update.trim();
            const country = acf.gas_country.trim() || 'Македонија';

            const parsedUpdate = new Date(lastUpdateRaw);
            const startsAt = Number.isNaN(parsedUpdate.getTime())
                ? now
                : parsedUpdate;

            const description = this.formatDescription(acf);

            return {
                externalId: this.buildExternalId(
                    item.id,
                    lastUpdateRaw,
                    p95,
                    p98,
                    diesel,
                ),
                source: this.source,
                category: this.category,
                title: this.formatTitle(),
                description,
                status: 'ongoing',
                observedAt: now,
                startsAt,
                endsAt: null,
                rawPayload: {
                    postId: item.id,
                    slug: item.slug,
                    country,
                    currency: acf.gas_currency.trim(),
                    pricesMkd: {
                        eurosuper95: acf.petrol95,
                        eurosuper98: acf.petrol98,
                        eurodiesel: acf.diesel,
                    },
                    pricesEur: {
                        eurosuper95: Number(acf.petrol95eur.toFixed(4)),
                        eurosuper98: Number(acf.petrol98eur.toFixed(4)),
                        eurodiesel: Number(acf.dieseleur.toFixed(4)),
                    },
                    lastUpdated: lastUpdateRaw,
                    modifiedAt: item.modified,
                },
            };
        });
    }

    private buildExternalId(
        postId: number,
        lastUpdateRaw: string,
        p95: string,
        p98: string,
        diesel: string,
    ): string {
        return hashExternalId(postId, lastUpdateRaw, p95, p98, diesel);
    }

    private formatTitle(): string {
        return 'Тековни цени на горива';
    }

    private formatDescription(acf: AmsmFuelAcf): string {
        const p95Mkd = this.formatMkd(acf.petrol95);
        const p98Mkd = this.formatMkd(acf.petrol98);
        const dieselMkd = this.formatMkd(acf.diesel);

        const p95Eur = acf.petrol95eur.toFixed(2);
        const p98Eur = acf.petrol98eur.toFixed(2);
        const dieselEur = acf.dieseleur.toFixed(2);

        return (
            `Актуелни малопродажни цени: ` +
            `бензин БС-95 = ${p95Mkd} ден/л (${p95Eur} EUR/л), ` +
            `бензин БС-98 = ${p98Mkd} ден/л (${p98Eur} EUR/л), ` +
            `Еуродизел = ${dieselMkd} ден/л (${dieselEur} EUR/л).`
        );
    }

    private formatMkd(value: number): string {
        return Number(value.toFixed(2)).toString();
    }
}
