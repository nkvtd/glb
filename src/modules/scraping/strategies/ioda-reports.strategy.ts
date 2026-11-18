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
import { fetchJson } from './util/fetch.js';
import {
    computeIodaAvailabilityPct,
    flattenIodaSignals,
    latestIodaTimestamp,
    metricForIodaSeries,
} from './util/ioda.js';
import { formatPercentComma } from './util/text.js';
import { floorToUtcHourIso } from './util/time.js';

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

type IodaConnectivity = 'normal' | 'degraded' | 'outage';

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
        const fetchDatasource = async (
            datasource: string,
        ): Promise<IodaSignalSeries[]> => {
            const requestUrl = new URL(
                `${base}/signals/raw/region/${regionCodes}`,
            );
            requestUrl.searchParams.set('from', String(from));
            requestUrl.searchParams.set('until', String(until));
            requestUrl.searchParams.set('datasource', datasource);
            return flattenIodaSignals(
                await fetchJson(requestUrl, iodaSignalsResponseSchema, {
                    headers: { Accept: 'application/json' },
                }),
            );
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
            const bgp = metricForIodaSeries(
                group.series.filter((item) => item.datasource === 'bgp'),
            );
            const ping = metricForIodaSeries(
                group.series.filter(
                    (item) => item.datasource === 'ping-slash24',
                ),
            );
            if (!bgp && !ping) continue;
            const connectivityStatus = this.classify(bgp, ping);
            const availability = computeIodaAvailabilityPct(bgp, ping, 5);
            const latest = latestIodaTimestamp(group.series);
            const startsAt = new Date(
                (latest ?? Math.floor(observedAt.getTime() / 1000)) * 1000,
            );
            const hourWindowUtc = floorToUtcHourIso(startsAt);
            const municipalityName = group.municipalityName;
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
                externalId: this.buildExternalId(
                    municipalityCode,
                    hourWindowUtc,
                    connectivityStatus,
                ),
                source: this.source,
                category: this.category,
                title: this.formatTitle(connectivityStatus, municipalityName),
                description: this.formatDescription(
                    connectivityStatus,
                    municipalityName,
                    availability,
                ),
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

    private classify(
        bgp: IodaSignalMetric | null,
        ping: IodaSignalMetric | null,
    ): IodaConnectivity {
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

    private buildExternalId(
        municipalityCode: string,
        hourWindowUtc: string,
        status: IodaConnectivity,
    ): string {
        return status === 'normal'
            ? `${municipalityCode}-${hourWindowUtc}`
            : `${municipalityCode}-${hourWindowUtc}-${status}`;
    }

    private formatTitle(
        status: IodaConnectivity,
        municipalityName: string,
    ): string {
        if (status === 'normal') {
            return `Интернет мрежа: ${municipalityName}`;
        }
        return status === 'degraded'
            ? `Отежнат интернет сообраќај: ${municipalityName}`
            : `Прекин на интернет: ${municipalityName}`;
    }

    private formatDescription(
        status: IodaConnectivity,
        municipalityName: string,
        availability: number,
    ): string {
        if (status === 'normal') {
            return `Интернет сообраќајот во ${municipalityName} се одвива нормално (${formatPercentComma(availability)} достапност).`;
        }
        return status === 'degraded'
            ? `Намалена достапност на интернет мрежата во ${municipalityName} (${formatPercentComma(availability)} од вообичаениот капацитет).`
            : `Прекин во интернет сообраќајот во ${municipalityName} (${formatPercentComma(availability)} достапност).`;
    }
}
