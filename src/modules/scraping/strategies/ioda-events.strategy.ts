import type {
    IodaEventInsert,
    IodaEventPayload,
    IodaOperatorSummary,
    IodaSignalMetric,
} from '../../../core/types/ioda.js';
import {
    type IodaSignalSeries,
    iodaSignalsResponseSchema,
} from '../../../core/validation/ioda.js';
import type { ScrapingStrategy } from '../strategy.interface.js';

const WINDOW_SECONDS = 86_400;
const DOMESTIC_OPERATORS: ReadonlyArray<{
    readonly name: string;
    readonly slug: string;
    readonly asns: readonly string[];
}> = [
    { name: 'Македонски Телеком', slug: 'telekom', asns: ['6821'] },
    {
        name: 'А1 Македонија',
        slug: 'a1',
        asns: ['16333', '43612', '57374', '43494'],
    },
    { name: 'Неотел', slug: 'neotel', asns: ['34772'] },
    { name: 'Телекабел', slug: 'telekabel', asns: ['41557', '44021'] },
    { name: 'Интерспејс', slug: 'interspace', asns: ['200899'] },
    { name: 'Телесмарт', slug: 'telesmart', asns: ['34547'] },
    { name: 'КДС-КабелНет', slug: 'kds', asns: ['44566'] },
    { name: 'Нет Кабел', slug: 'netkabel', asns: ['39766'] },
    { name: 'УлтраНет', slug: 'ultranet', asns: ['8830'] },
    { name: 'УКИМ', slug: 'ukim', asns: ['5379'] },
    { name: 'Инел', slug: 'inel', asns: ['49056'] },
    { name: 'Пет Нет', slug: 'petnet', asns: ['199128'] },
    { name: 'Телекс', slug: 'teleks', asns: ['205119'] },
    { name: 'УГД', slug: 'ugd', asns: ['47212'] },
    { name: 'МАРнет', slug: 'marnet', asns: ['44224'] },
];

export type IodaEventsRaw = {
    countrySeries: IodaSignalSeries[];
    asnSeries: IodaSignalSeries[];
};

function median(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    const value =
        sorted.length % 2
            ? (sorted[middle] ?? 0)
            : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
    return Number(value.toFixed(1));
}

function metricForSeries(series: IodaSignalSeries[]): IodaSignalMetric | null {
    let current = 0;
    let baseline = 0;
    let found = false;
    for (const item of series) {
        const samples = item.values.filter(
            (value): value is number =>
                value !== null &&
                value !== undefined &&
                Number.isFinite(value) &&
                value >= 0,
        );
        if (!samples.length) continue;
        const itemBaseline = median(samples);
        if (itemBaseline <= 0) continue;
        for (let index = item.values.length - 1; index >= 0; index--) {
            const value = item.values[index];
            if (
                value !== null &&
                value !== undefined &&
                Number.isFinite(value) &&
                value >= 0
            ) {
                current += value;
                baseline += itemBaseline;
                found = true;
                break;
            }
        }
    }
    if (!found || baseline <= 0) return null;
    baseline = Number(baseline.toFixed(1));
    return {
        current,
        baseline,
        ratio: Number((current / baseline).toFixed(4)),
    };
}

function classifyConnectivity(
    bgp: IodaSignalMetric | null,
    ping: IodaSignalMetric | null,
): 'normal' | 'degraded' | 'outage' {
    const hasBgp = bgp !== null && bgp.baseline >= 10;
    const hasPing = ping !== null && ping.baseline >= 10;
    if (
        (bgp !== null && bgp.baseline >= 4 && bgp.current === 0) ||
        (hasBgp && bgp.ratio < 0.85) ||
        (hasBgp && hasPing && bgp.ratio < 0.95 && ping.ratio < 0.7) ||
        (!hasBgp && hasPing && ping.ratio < 0.5)
    )
        return 'outage';
    if (
        (hasBgp && bgp.ratio < 0.95) ||
        (hasPing && ping.ratio < 0.8 && (!hasBgp || bgp.ratio < 0.98))
    )
        return 'degraded';
    return 'normal';
}

function availabilityPct(
    bgp: IodaSignalMetric | null,
    ping: IodaSignalMetric | null,
): number {
    const hasBgp = bgp !== null && bgp.baseline >= 10;
    const hasPing = ping !== null && ping.baseline >= 10;
    const ratio =
        hasBgp && hasPing
            ? Math.min(1, bgp.ratio) * 0.7 + Math.min(1, ping.ratio) * 0.3
            : hasBgp
              ? Math.min(1, bgp.ratio)
              : hasPing
                ? Math.min(1, ping.ratio)
                : bgp !== null
                  ? Math.min(1, bgp.ratio)
                  : ping !== null
                    ? Math.min(1, ping.ratio)
                    : 0;
    return Math.max(0, Math.min(100, Number((ratio * 100).toFixed(1))));
}

function fmtPct(value: number): string {
    return `${Number.isInteger(value) ? value : value.toFixed(1).replace('.', ',')}%`;
}

function flattenResponse(value: unknown): IodaSignalSeries[] {
    const body = iodaSignalsResponseSchema.parse(value);
    if (body.error !== null)
        throw new Error(`IODA request failed: ${body.error}`);
    return (body.data ?? []).flat();
}

function latestTimestamp(series: IodaSignalSeries[]): number | null {
    let latest: number | null = null;
    for (const item of series) {
        for (let index = item.values.length - 1; index >= 0; index--) {
            const value = item.values[index];
            if (
                value !== null &&
                value !== undefined &&
                Number.isFinite(value) &&
                value >= 0
            ) {
                const timestamp = item.from + index * item.step;
                latest =
                    latest === null ? timestamp : Math.max(latest, timestamp);
                break;
            }
        }
    }
    return latest;
}

function recoveryTimestamp(
    series: IodaSignalSeries[],
    minTimestampSec: number,
): number | null {
    let recoveredAt: number | null = null;
    for (const item of series) {
        const values = item.values.map((value) =>
            value !== null &&
            value !== undefined &&
            Number.isFinite(value) &&
            value >= 0
                ? value
                : null,
        );
        const baselineValues = values.filter(
            (value): value is number => value !== null,
        );
        const baseline = median(baselineValues);
        if (baseline < 10) continue;
        let observedDrop = false;
        for (let index = 0; index < values.length; index++) {
            const value = values[index];
            if (value === null || value === undefined) continue;
            if (value < baseline * 0.95) {
                observedDrop = true;
            } else if (observedDrop) {
                const timestamp = item.from + index * item.step;
                if (timestamp >= minTimestampSec) {
                    recoveredAt =
                        recoveredAt === null
                            ? timestamp
                            : Math.max(recoveredAt, timestamp);
                }
                observedDrop = false;
            }
        }
    }
    return recoveredAt;
}

function todayInSkopje(date: Date): string {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Europe/Skopje',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).formatToParts(date);
    const part = (type: string) =>
        parts.find((item) => item.type === type)?.value ?? '';
    return `${part('year')}-${part('month')}-${part('day')}`;
}

export class IodaEventsStrategy
    implements ScrapingStrategy<IodaEventsRaw, IodaEventInsert>
{
    readonly source = 'ioda';
    readonly url: string;
    readonly category = 'internet' as const;
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

    async fetch(): Promise<IodaEventsRaw> {
        const until = Math.floor(this.now().getTime() / 1000);
        const from = until - WINDOW_SECONDS;
        const base = this.url
            .replace(/\/+$/, '')
            .replace(/\/outages\/events$/, '');
        const request = async (entity: string, datasource: string) => {
            const url = `${base}/signals/raw/${entity}`;
            const requestUrl = new URL(url);
            requestUrl.searchParams.set('from', String(from));
            requestUrl.searchParams.set('until', String(until));
            requestUrl.searchParams.set('datasource', datasource);
            const response = await fetch(requestUrl, {
                headers: { Accept: 'application/json' },
                signal: AbortSignal.timeout(15_000),
            });
            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(
                    `Fetch failed with status code ${response.status}: ${errorText}`,
                );
            }
            return flattenResponse(await response.json());
        };

        const asns = DOMESTIC_OPERATORS.flatMap((operator) => operator.asns);
        const countrySignals = await Promise.all([
            request('country/MK', 'bgp'),
            request('country/MK', 'ping-slash24'),
        ]);
        const asnSignals = await Promise.all([
            request(`asn/${asns.join(',')}`, 'bgp'),
            request(`asn/${asns.join(',')}`, 'ping-slash24'),
        ]);
        return {
            countrySeries: countrySignals.flat(),
            asnSeries: asnSignals.flat(),
        };
    }

    async parse(raw: IodaEventsRaw): Promise<IodaEventInsert[]> {
        const bgpSeries = raw.countrySeries.filter(
            (series) => series.datasource === 'bgp',
        );
        const pingSeries = raw.countrySeries.filter(
            (series) => series.datasource === 'ping-slash24',
        );
        const bgp = metricForSeries(bgpSeries);
        const ping = metricForSeries(pingSeries);
        if (!bgp && !ping) return [];

        const operators: IodaOperatorSummary[] = DOMESTIC_OPERATORS.map(
            (operator) => {
                const matching = raw.asnSeries.filter((series) =>
                    operator.asns.includes(series.entityCode),
                );
                const opBgp = metricForSeries(
                    matching.filter((series) => series.datasource === 'bgp'),
                );
                const opPing = metricForSeries(
                    matching.filter(
                        (series) => series.datasource === 'ping-slash24',
                    ),
                );
                return {
                    name: operator.name,
                    asns: [...operator.asns],
                    status: classifyConnectivity(opBgp, opPing),
                    availabilityPct: availabilityPct(opBgp, opPing),
                    bgp: opBgp,
                    ping: opPing,
                };
            },
        );
        const affected = operators.filter(
            (operator) => operator.status !== 'normal',
        );
        const nationalStatus = classifyConnectivity(bgp, ping);
        const status =
            nationalStatus === 'outage' ||
            affected.some((op) => op.status === 'outage')
                ? 'outage'
                : nationalStatus === 'degraded' || affected.length > 0
                  ? 'degraded'
                  : 'normal';
        const overallAvailability = availabilityPct(bgp, ping);
        const affectedList = affected
            .map((op) => `${op.name} (${fmtPct(op.availabilityPct)})`)
            .join(', ');
        let title: string;
        let description: string;
        if (status === 'normal') {
            title = 'Состојба на интернет мрежата';
            description = `Националната интернет мрежа е стабилна (${fmtPct(overallAvailability)} достапност), сите оператори функционираат нормално.`;
        } else if (status === 'degraded' && affected.length === 1) {
            const op = affected[0];
            if (!op) throw new Error('Expected one affected operator');
            title = `Отежнат интернет сообраќај: ${op.name}`;
            description = `Намалена достапност на интернет мрежата на ${op.name} (${fmtPct(op.availabilityPct)} од капацитетот) на национално ниво.`;
        } else if (status === 'degraded' && affected.length > 1) {
            title = 'Отежнат интернет сообраќај кај повеќе оператори';
            description = `Намалена достапност на интернет мрежата на национално ниво кај: ${affectedList}.`;
        } else if (status === 'degraded') {
            title = 'Отежнат национален интернет сообраќај';
            description = `Намалена достапност на националната интернет мрежа во Македонија (${fmtPct(overallAvailability)} од капацитетот).`;
        } else if (nationalStatus === 'outage') {
            title = 'Национален прекин на интернет мрежата';
            description = `Национален прекин на интернет сообраќајот во Македонија (${fmtPct(overallAvailability)} достапност)${affectedList ? `, погодени оператори: ${affectedList}` : ''}.`;
        } else if (affected.length === 1) {
            const op = affected[0];
            if (!op) throw new Error('Expected one affected operator');
            title = `Прекин на интернет мрежата: ${op.name}`;
            description = `Прекин во интернет мрежата на ${op.name} (${fmtPct(op.availabilityPct)} достапност).`;
        } else {
            title = 'Прекин кај интернет операторите';
            description = `Прекин во интернет мрежата кај: ${affectedList}.`;
        }

        const observedAt = this.now();
        const todayKey = todayInSkopje(observedAt);
        const minTimestampSec = Math.floor(
            Date.parse(`${todayKey}T00:00:00Z`) / 1000,
        );
        const recoverySec = recoveryTimestamp(bgpSeries, minTimestampSec);
        const affectedSlugs = affected
            .map(
                (operator) =>
                    DOMESTIC_OPERATORS.find(
                        (item) => item.name === operator.name,
                    )?.slug,
            )
            .filter((slug): slug is string => slug !== undefined);
        const statusKey =
            status === 'normal'
                ? `normal${recoverySec === null ? '' : `-${recoverySec}`}`
                : `${status}-${affectedSlugs.join('-') || 'national'}`;
        const externalId = `ioda-mk-${todayKey}-${statusKey}`;
        const latest = latestTimestamp([
            ...raw.countrySeries,
            ...raw.asnSeries,
        ]);
        const payload: IodaEventPayload = {
            countryCode: 'MK',
            status,
            availabilityPct: overallAvailability,
            bgp,
            ping,
            affectedOperators: affected.map((op) => op.name),
            operators,
        };
        return [
            {
                externalId,
                source: this.source,
                category: this.category,
                title,
                description,
                status: status === 'normal' ? 'omitted' : 'ongoing',
                observedAt,
                startsAt: new Date(
                    (latest ?? Math.floor(observedAt.getTime() / 1000)) * 1000,
                ),
                endsAt: null,
                rawPayload: payload,
            },
        ];
    }
}
