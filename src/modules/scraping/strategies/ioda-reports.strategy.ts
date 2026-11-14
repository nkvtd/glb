import type {
    IodaReportInsert,
    IodaReportPayload,
    IodaSignalMetric,
} from '../../../core/types/ioda.js';
import {
    type IodaSignalSeries,
    iodaSignalsResponseSchema,
} from '../../../core/validation/ioda.js';
import type { MunicipalityResolver } from '../resolver.js';
import type { ScrapingStrategy } from '../strategy.interface.js';

const WINDOW_SECONDS = 86_400;
const IGNORED_REGION_CODES = new Set(['2592', '4870']);
const REGION_NAME_OVERRIDES: Readonly<Record<string, string>> = {
    '2598': 'Росоман',
    '2601': 'Старо Нагоричане',
    '2636': 'Могила',
    '2649': 'Врапчиште',
    '2654': 'Струмица',
    '2659': 'Гевгелија',
    '2666': 'Пехчево',
    '2635': 'Македонски Брод',
    '2607': 'Кичево',
    '2640': 'Кичево',
    '2643': 'Кичево',
    '2646': 'Кичево',
};

export type IodaReportsRaw = IodaSignalSeries[];

function median(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    const result =
        sorted.length % 2
            ? (sorted[middle] ?? 0)
            : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
    return Number(result.toFixed(1));
}

function metricForSeries(series: IodaSignalSeries[]): IodaSignalMetric | null {
    let current = 0;
    let baseline = 0;
    let found = false;
    for (const item of series) {
        const values = item.values.filter(
            (value): value is number =>
                value !== null &&
                value !== undefined &&
                Number.isFinite(value) &&
                value >= 0,
        );
        if (!values.length) continue;
        const itemBaseline = median(values);
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

function classify(
    bgp: IodaSignalMetric | null,
    ping: IodaSignalMetric | null,
): 'normal' | 'degraded' | 'outage' {
    const hasBgp = bgp !== null && bgp.baseline >= 5;
    const hasPing = ping !== null && ping.baseline >= 10;
    if (
        (bgp !== null && bgp.baseline >= 2 && bgp.current === 0) ||
        (hasBgp && bgp.ratio < 0.75) ||
        (hasBgp && hasPing && bgp.ratio < 0.9 && ping.ratio < 0.65) ||
        (!hasBgp && hasPing && ping.ratio < 0.5)
    )
        return 'outage';
    if ((hasBgp && bgp.ratio < 0.9) || (hasPing && ping.ratio < 0.75)) {
        return 'degraded';
    }
    return 'normal';
}

function getAvailabilityPct(
    bgp: IodaSignalMetric | null,
    ping: IodaSignalMetric | null,
): number {
    const hasBgp = bgp !== null && bgp.baseline >= 5;
    const hasPing = ping !== null && ping.baseline >= 10;
    const ratio =
        hasBgp && hasPing
            ? Math.min(1, bgp.ratio) * 0.7 + Math.min(1, ping.ratio) * 0.3
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

function latestTimestamp(series: IodaSignalSeries[]): number {
    let latest = 0;
    for (const item of series) {
        for (let index = item.values.length - 1; index >= 0; index--) {
            const value = item.values[index];
            if (
                value !== null &&
                value !== undefined &&
                Number.isFinite(value) &&
                value >= 0
            ) {
                latest = Math.max(latest, item.from + index * item.step);
                break;
            }
        }
    }
    return latest;
}

export class IodaReportsStrategy
    implements ScrapingStrategy<IodaReportsRaw, IodaReportInsert>
{
    readonly source = 'ioda-regions';
    readonly url: string;
    readonly category = 'internet' as const;
    readonly target = 'reports';
    readonly schedule: string;
    readonly stateFeed = true;
    private readonly resolver: MunicipalityResolver;
    private readonly now: () => Date;

    constructor(
        url: string,
        schedule: string,
        resolver: MunicipalityResolver,
        now: () => Date = () => new Date(),
    ) {
        this.url = url;
        this.schedule = schedule;
        this.resolver = resolver;
        this.now = now;
    }

    async fetch(): Promise<IodaReportsRaw> {
        const until = Math.floor(this.now().getTime() / 1000);
        const from = until - WINDOW_SECONDS;
        const base = this.url
            .replace(/\/+$/, '')
            .replace(/\/outages\/events$/, '');
        const regionCodes = Array.from({ length: 84 }, (_, index) =>
            String(2586 + index),
        )
            .filter((code) => !IGNORED_REGION_CODES.has(code))
            .join(',');
        const fetchDatasource = async (datasource: string) => {
            const requestUrl = new URL(
                `${base}/signals/raw/region/${regionCodes}`,
            );
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
        const [bgp, ping] = await Promise.all([
            fetchDatasource('bgp'),
            fetchDatasource('ping-slash24'),
        ]);
        return [...bgp, ...ping];
    }

    async parse(series: IodaReportsRaw): Promise<IodaReportInsert[]> {
        const grouped = new Map<
            string,
            {
                municipalityName: string;
                regionCodes: Set<string>;
                series: IodaSignalSeries[];
            }
        >();
        for (const item of series) {
            if (IGNORED_REGION_CODES.has(item.entityCode)) continue;
            const lookupName =
                REGION_NAME_OVERRIDES[item.entityCode] ?? item.entityName;
            const municipalityCode = this.resolver.resolveText(lookupName);
            if (!municipalityCode) continue;
            const municipalityName =
                this.resolver
                    .resolveRegion(municipalityCode.slice(0, 5))
                    .find((m) => m.code === municipalityCode)?.nameMk ??
                lookupName;
            const group = grouped.get(municipalityCode) ?? {
                municipalityName,
                regionCodes: new Set<string>(),
                series: [],
            };
            group.regionCodes.add(item.entityCode);
            group.series.push(item);
            grouped.set(municipalityCode, group);
        }

        const observedAt = this.now();
        const rows: IodaReportInsert[] = [];
        for (const [municipalityCode, group] of grouped) {
            const bgp = metricForSeries(
                group.series.filter((item) => item.datasource === 'bgp'),
            );
            const ping = metricForSeries(
                group.series.filter(
                    (item) => item.datasource === 'ping-slash24',
                ),
            );
            if (!bgp && !ping) continue;
            const connectivityStatus = classify(bgp, ping);
            const availability = getAvailabilityPct(bgp, ping);
            const latest = latestTimestamp(group.series);
            const startsAt = new Date(
                (latest || Math.floor(observedAt.getTime() / 1000)) * 1000,
            );
            const hourWindowUtc = `${startsAt.toISOString().slice(0, 13)}:00:00Z`;
            const externalId =
                connectivityStatus === 'normal'
                    ? `${municipalityCode}-${hourWindowUtc}`
                    : `${municipalityCode}-${hourWindowUtc}-${connectivityStatus}`;
            const municipalityName = group.municipalityName;
            const title =
                connectivityStatus === 'normal'
                    ? `Интернет мрежа: ${municipalityName}`
                    : connectivityStatus === 'degraded'
                      ? `Отежнат интернет сообраќај: ${municipalityName}`
                      : `Прекин на интернет: ${municipalityName}`;
            const description =
                connectivityStatus === 'normal'
                    ? `Интернет сообраќајот во ${municipalityName} се одвива нормално (${fmtPct(availability)} достапност).`
                    : connectivityStatus === 'degraded'
                      ? `Намалена достапност на интернет мрежата во ${municipalityName} (${fmtPct(availability)} од вообичаениот капацитет).`
                      : `Прекин во интернет сообраќајот во ${municipalityName} (${fmtPct(availability)} достапност).`;
            const payload: IodaReportPayload = {
                municipalityCode,
                municipalityName,
                regionCodes: [...group.regionCodes].sort(),
                status: connectivityStatus,
                availabilityPct: availability,
                bgp,
                ping,
            };
            rows.push({
                externalId,
                source: this.source,
                category: this.category,
                title,
                description,
                municipalityCode,
                locationLabel: municipalityName,
                geom: null,
                status: connectivityStatus === 'normal' ? 'omitted' : 'ongoing',
                observedAt,
                startsAt,
                endsAt: null,
                rawPayload: payload,
            });
        }
        return rows;
    }
}
