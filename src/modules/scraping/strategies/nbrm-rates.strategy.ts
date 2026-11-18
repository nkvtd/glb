import type {
    NbrmRateEntry,
    NbrmRatesEventInsert,
} from '../../../core/types/nbrm-rates.js';
import {
    type NbrmRateItem,
    nbrmRatesResponseSchema,
} from '../../../core/validation/nbrm-rates.js';
import type { ScrapingStrategy } from '../strategy.interface.js';
import { fetchJson } from './util/fetch.js';
import { formatDecimalComma } from './util/text.js';
import { formatLocalDate, parseLocalMidnight } from './util/time.js';

const MAIN_CURRENCIES = ['EUR', 'USD', 'GBP', 'CHF'];
const DATUM_DATE_RE = /^(\d{4}-\d{2}-\d{2})/;

type NbrmRateGroup = {
    rBr: number;
    datum_f: string;
    dates: Set<string>;
    rates: Map<string, NbrmRateEntry>;
};

export class NbrmRatesStrategy
    implements ScrapingStrategy<NbrmRateItem[], NbrmRatesEventInsert>
{
    readonly source = 'nbrm-rates';
    readonly url: string;
    readonly category = 'currency_exchange' as const;
    readonly target = 'events';
    readonly schedule: string;
    readonly stateFeed = true;
    private readonly now: () => Date;

    constructor(
        url: string,
        schedule: string,
        now: () => Date = () => new Date(),
    ) {
        this.url = url;
        this.schedule = schedule;
        this.now = now;
    }

    async fetch(): Promise<NbrmRateItem[]> {
        const url = new URL(this.url);
        const todayKey = formatLocalDate(this.now());
        const endDate = new Date(`${todayKey}T00:00:00Z`);
        const startDate = new Date(endDate);
        startDate.setUTCDate(startDate.getUTCDate() - 10);

        url.searchParams.set('StartDate', this.formatRequestDate(startDate));
        url.searchParams.set('EndDate', this.formatRequestDate(endDate));
        url.searchParams.set('format', 'json');

        return fetchJson(url, nbrmRatesResponseSchema, {
            headers: { Accept: 'application/json' },
            rejectHtml: true,
        });
    }

    async parse(items: NbrmRateItem[]): Promise<NbrmRatesEventInsert[]> {
        if (items.length === 0) return [];

        const now = this.now();
        const todayKey = formatLocalDate(now);
        const groups = new Map<number, NbrmRateGroup>();

        for (const item of items) {
            const dateMatch = item.datum.match(DATUM_DATE_RE);
            const date = dateMatch?.[1];
            if (!date || !this.isValidDate(date)) continue;

            let group = groups.get(item.rBr);

            if (!group) {
                group = {
                    rBr: item.rBr,
                    datum_f: item.datum_f,
                    dates: new Set(),
                    rates: new Map(),
                };
                groups.set(item.rBr, group);
            }

            group.dates.add(date);
            const rateKey = item.oznaka.trim().toUpperCase();
            if (!group.rates.has(rateKey)) {
                group.rates.set(rateKey, {
                    oznaka: item.oznaka,
                    valuta: item.valuta,
                    nazivMak: item.nazivMak,
                    nomin: item.nomin,
                    sreden: item.sreden,
                });
            }
        }

        const orderedGroups = Array.from(groups.values(), (group) => ({
            ...group,
            dates: Array.from(group.dates).sort(),
            rates: Array.from(group.rates.values()),
        }));

        const selectedGroup =
            orderedGroups
                .filter((group) => group.dates.includes(todayKey))
                .sort((a, b) => b.rBr - a.rBr)[0] ??
            orderedGroups
                .filter((group) => group.dates.some((date) => date <= todayKey))
                .sort((a, b) => {
                    const latestA =
                        a.dates.filter((date) => date <= todayKey).at(-1) ?? '';
                    const latestB =
                        b.dates.filter((date) => date <= todayKey).at(-1) ?? '';
                    return latestB.localeCompare(latestA) || b.rBr - a.rBr;
                })[0];

        if (!selectedGroup) return [];

        const firstDay = selectedGroup.dates[0];
        if (!firstDay) return [];
        const year = firstDay.slice(0, 4);
        const startsAt = parseLocalMidnight(firstDay);
        const mainRates = selectedGroup.rates.filter((rate) =>
            MAIN_CURRENCIES.includes(rate.oznaka.trim().toUpperCase()),
        );
        const ratesForDescription =
            mainRates.length > 0 ? mainRates : selectedGroup.rates.slice(0, 4);

        return [
            {
                externalId: this.buildExternalId(year, selectedGroup.rBr),
                source: this.source,
                category: this.category,
                title: this.formatTitle(),
                description: this.formatDescription(ratesForDescription),
                status: 'ongoing',
                observedAt: now,
                startsAt,
                endsAt: null,
                rawPayload: {
                    rBr: selectedGroup.rBr,
                    datum_f: selectedGroup.datum_f,
                    dates: selectedGroup.dates,
                    rates: selectedGroup.rates,
                },
            },
        ];
    }

    private buildExternalId(year: string, rBr: number): string {
        return `nbrm-${year}-${rBr}`;
    }

    private formatTitle(): string {
        return 'Тековна курсна листа';
    }

    private formatDescription(rates: NbrmRateEntry[]): string {
        const rateDescription = rates
            .map(
                (rate) =>
                    `${rate.oznaka} = ${formatDecimalComma(rate.sreden, 4)} ден.`,
            )
            .join(', ');

        return `Актуелни средни курсеви: ${rateDescription}`;
    }

    private formatRequestDate(date: Date): string {
        const day = String(date.getUTCDate()).padStart(2, '0');
        const month = String(date.getUTCMonth() + 1).padStart(2, '0');
        return `${day}.${month}.${date.getUTCFullYear()}`;
    }

    private isValidDate(date: string): boolean {
        const parsed = new Date(`${date}T00:00:00Z`);
        return (
            !Number.isNaN(parsed.getTime()) &&
            parsed.toISOString().startsWith(date)
        );
    }
}
