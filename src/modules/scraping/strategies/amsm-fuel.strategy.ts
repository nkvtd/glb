import { createHash } from 'node:crypto';
import type { AmsmFuelEventInsert } from '../../../core/types/amsm-fuel.js';
import {
    type AmsmFuelAcf,
    type AmsmFuelItem,
    amsmFuelResponseSchema,
} from '../../../core/validation/amsm-fuel.js';
import type { ScrapingStrategy } from '../strategy.interface.js';

export class AmsmFuelStrategy
    implements ScrapingStrategy<AmsmFuelItem[], AmsmFuelEventInsert>
{
    readonly source = 'amsm-fuel';
    readonly url: string;
    readonly category = 'fuel_price' as const;
    readonly target = 'events';
    readonly schedule: string;

    constructor(url: string, schedule: string) {
        this.url = url;
        this.schedule = schedule;
    }

    async fetch(): Promise<AmsmFuelItem[]> {
        const response = await fetch(this.url, {
            signal: AbortSignal.timeout(15_000),
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(
                `Fetch failed with status code ${response.status}: ${errorText}`,
            );
        }

        const data = await response.json();

        return amsmFuelResponseSchema.parse(data);
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

            const externalId = createHash('sha256')
                .update(`${item.id}|${lastUpdateRaw}|${p95}|${p98}|${diesel}`)
                .digest('hex')
                .slice(0, 32);

            const parsedUpdate = new Date(lastUpdateRaw);
            const startsAt = Number.isNaN(parsedUpdate.getTime())
                ? now
                : parsedUpdate;

            const title = `Тековни цени на горива`;
            const description = this.formatDescription(acf, country);

            return {
                externalId,
                source: this.source,
                category: this.category,
                title,
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

    private formatDescription(acf: AmsmFuelAcf, country: string): string {
        const p95Mkd = this.formatMkd(acf.petrol95);
        const p98Mkd = this.formatMkd(acf.petrol98);
        const dieselMkd = this.formatMkd(acf.diesel);

        const p95Eur = acf.petrol95eur.toFixed(2);
        const p98Eur = acf.petrol98eur.toFixed(2);
        const dieselEur = acf.dieseleur.toFixed(2);

        return (
            `Актуелните малопродажни цени на нафтените деривати во ${country} изнесуваат: ` +
            `бензин ЕУРОСУПЕР БС-95 се продава по цена од ${p95Mkd} ден/л (${p95Eur} EUR/л), ` +
            `бензин ЕУРОСУПЕР БС-98 изнесува ${p98Mkd} ден/л (${p98Eur} EUR/л), ` +
            `додека дизел ЕУРОДИЗЕЛ БС (Д-Е V) се точи по цена од ${dieselMkd} ден/л (${dieselEur} EUR/л).`
        );
    }

    private formatMkd(value: number): string {
        return Number(value.toFixed(2)).toString();
    }
}
