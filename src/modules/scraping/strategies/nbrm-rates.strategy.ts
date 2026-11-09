import type {
    NbrmRateEntry,
    NbrmRatesEventInsert,
} from '../../../core/types/nbrm-rates.js';
import {
    type NbrmRateItem,
    nbrmRatesResponseSchema,
} from '../../../core/validation/nbrm-rates.js';
import type { ScrapingStrategy } from '../strategy.interface.js';

const SKOPJE_DATE_FORMATTER = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Skopje',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
});

const SKOPJE_OFFSET_FORMATTER = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Skopje',
    timeZoneName: 'longOffset',
});

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
        const todayKey = this.formatSkopjeDate(this.now());
        const endDate = new Date(`${todayKey}T00:00:00Z`);
        const startDate = new Date(endDate);
        startDate.setUTCDate(startDate.getUTCDate() - 10);

        url.searchParams.set('StartDate', this.formatRequestDate(startDate));
        url.searchParams.set('EndDate', this.formatRequestDate(endDate));
        url.searchParams.set('format', 'json');

        const response = await fetch(url, {
            headers: { Accept: 'application/json' },
            signal: AbortSignal.timeout(15_000),
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(
                `Fetch failed with status code ${response.status}: ${errorText}`,
            );
        }

        if (
            response.headers
                .get('content-type')
                ?.toLowerCase()
                .includes('text/html')
        ) {
            const errorText = await response.text();
            throw new Error(`Fetch returned an HTML error page: ${errorText}`);
        }

        const data = await response.json();
        return nbrmRatesResponseSchema.parse(data);
    }

    async parse(items: NbrmRateItem[]): Promise<NbrmRatesEventInsert[]> {
        if (items.length === 0) return [];

        const now = this.now();
        const todayKey = this.formatSkopjeDate(now);
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
        const startsAt = this.parseSkopjeMidnight(firstDay);
        const mainRates = selectedGroup.rates.filter((rate) =>
            MAIN_CURRENCIES.includes(rate.oznaka.trim().toUpperCase()),
        );
        const ratesForDescription =
            mainRates.length > 0 ? mainRates : selectedGroup.rates.slice(0, 4);
        const rateDescription = ratesForDescription
            .map(
                (rate) =>
                    `${rate.oznaka} = ${rate.sreden.toFixed(4).replace('.', ',')} ден.`,
            )
            .join(', ');

        return [
            {
                externalId: `nbrm-${year}-${selectedGroup.rBr}`,
                source: this.source,
                category: this.category,
                title: `Тековна курсна листа`,
                description: `Актуелни средни курсеви: ${rateDescription}`,
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

    private formatSkopjeDate(date: Date): string {
        const parts = SKOPJE_DATE_FORMATTER.formatToParts(date);
        const year = parts.find((part) => part.type === 'year')?.value ?? '';
        const month = parts.find((part) => part.type === 'month')?.value ?? '';
        const day = parts.find((part) => part.type === 'day')?.value ?? '';
        return `${year}-${month}-${day}`;
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

    private parseSkopjeMidnight(date: string): Date {
        const probe = new Date(`${date}T00:00:00Z`);
        const offsetName =
            SKOPJE_OFFSET_FORMATTER.formatToParts(probe).find(
                (part) => part.type === 'timeZoneName',
            )?.value ?? 'GMT+01:00';
        const offset = offsetName.replace('GMT', '');
        const normalizedOffset = /^[+-]\d{2}:\d{2}$/.test(offset)
            ? offset
            : '+01:00';
        return new Date(`${date}T00:00:00.000${normalizedOffset}`);
    }
}
