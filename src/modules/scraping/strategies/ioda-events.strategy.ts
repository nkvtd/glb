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
import { fetchJson } from './util/fetch.js';
import {
    computeIodaAvailabilityPct,
    flattenIodaSignals,
    latestIodaTimestamp,
    metricForIodaSeries,
} from './util/ioda.js';
import { median } from './util/math.js';
import { formatPercentComma } from './util/text.js';
import { formatLocalDate, parseLocalMidnight } from './util/time.js';

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

type IodaConnectivity = 'normal' | 'degraded' | 'outage';

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
        const request = async (
            entity: string,
            datasource: string,
        ): Promise<IodaSignalSeries[]> => {
            const requestUrl = new URL(`${base}/signals/raw/${entity}`);
            requestUrl.searchParams.set('from', String(from));
            requestUrl.searchParams.set('until', String(until));
            requestUrl.searchParams.set('datasource', datasource);
            return flattenIodaSignals(
                await fetchJson(requestUrl, iodaSignalsResponseSchema, {
                    headers: { Accept: 'application/json' },
                }),
            );
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
        const bgp = metricForIodaSeries(bgpSeries);
        const ping = metricForIodaSeries(pingSeries);
        if (!bgp && !ping) return [];

        const operators: IodaOperatorSummary[] = DOMESTIC_OPERATORS.map(
            (operator) => {
                const matching = raw.asnSeries.filter((series) =>
                    operator.asns.includes(series.entityCode),
                );
                const opBgp = metricForIodaSeries(
                    matching.filter((series) => series.datasource === 'bgp'),
                );
                const opPing = metricForIodaSeries(
                    matching.filter(
                        (series) => series.datasource === 'ping-slash24',
                    ),
                );
                return {
                    name: operator.name,
                    asns: [...operator.asns],
                    status: this.classifyConnectivity(opBgp, opPing),
                    availabilityPct: computeIodaAvailabilityPct(
                        opBgp,
                        opPing,
                        10,
                    ),
                    bgp: opBgp,
                    ping: opPing,
                };
            },
        );
        const affected = operators.filter(
            (operator) => operator.status !== 'normal',
        );
        const nationalStatus = this.classifyConnectivity(bgp, ping);
        const status: IodaConnectivity =
            nationalStatus === 'outage' ||
            affected.some((op) => op.status === 'outage')
                ? 'outage'
                : nationalStatus === 'degraded' || affected.length > 0
                  ? 'degraded'
                  : 'normal';
        const overallAvailability = computeIodaAvailabilityPct(bgp, ping, 10);
        const affectedList = affected
            .map(
                (op) =>
                    `${op.name} (${formatPercentComma(op.availabilityPct)})`,
            )
            .join(', ');

        const observedAt = this.now();
        const todayKey = formatLocalDate(observedAt);
        const minTimestampSec = Math.floor(
            parseLocalMidnight(todayKey).getTime() / 1000,
        );
        const recoverySec = this.recoveryTimestamp(bgpSeries, minTimestampSec);
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
        const latest = latestIodaTimestamp([
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
                externalId: this.buildExternalId(todayKey, statusKey),
                source: this.source,
                category: this.category,
                title: this.formatTitle(status, nationalStatus, affected),
                description: this.formatDescription({
                    status,
                    nationalStatus,
                    affected,
                    overallAvailability,
                    affectedList,
                }),
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

    private classifyConnectivity(
        bgp: IodaSignalMetric | null,
        ping: IodaSignalMetric | null,
    ): IodaConnectivity {
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

    private recoveryTimestamp(
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

    private buildExternalId(todayKey: string, statusKey: string): string {
        return `ioda-mk-${todayKey}-${statusKey}`;
    }

    private formatTitle(
        status: IodaConnectivity,
        nationalStatus: IodaConnectivity,
        affected: IodaOperatorSummary[],
    ): string {
        if (status === 'normal') return 'Состојба на интернет мрежата';
        if (status === 'degraded') {
            if (affected.length === 1) {
                const op = affected[0];
                if (!op) throw new Error('Expected one affected operator');
                return `Отежнат интернет сообраќај: ${op.name}`;
            }
            if (affected.length > 1) {
                return 'Отежнат интернет сообраќај кај повеќе оператори';
            }
            return 'Отежнат национален интернет сообраќај';
        }
        if (nationalStatus === 'outage') {
            return 'Национален прекин на интернет мрежата';
        }
        if (affected.length === 1) {
            const op = affected[0];
            if (!op) throw new Error('Expected one affected operator');
            return `Прекин на интернет мрежата: ${op.name}`;
        }
        return 'Прекин кај интернет операторите';
    }

    private formatDescription(params: {
        status: IodaConnectivity;
        nationalStatus: IodaConnectivity;
        affected: IodaOperatorSummary[];
        overallAvailability: number;
        affectedList: string;
    }): string {
        const { status, nationalStatus, affected } = params;
        if (status === 'normal') {
            return `Националната интернет мрежа е стабилна (${formatPercentComma(params.overallAvailability)} достапност), сите оператори функционираат нормално.`;
        }
        if (status === 'degraded') {
            if (affected.length === 1) {
                const op = affected[0];
                if (!op) throw new Error('Expected one affected operator');
                return `Намалена достапност на интернет мрежата на ${op.name} (${formatPercentComma(op.availabilityPct)} од капацитетот) на национално ниво.`;
            }
            if (affected.length > 1) {
                return `Намалена достапност на интернет мрежата на национално ниво кај: ${params.affectedList}.`;
            }
            return `Намалена достапност на националната интернет мрежа во Македонија (${formatPercentComma(params.overallAvailability)} од капацитетот).`;
        }
        if (nationalStatus === 'outage') {
            return `Национален прекин на интернет сообраќајот во Македонија (${formatPercentComma(params.overallAvailability)} достапност)${params.affectedList ? `, погодени оператори: ${params.affectedList}` : ''}.`;
        }
        if (affected.length === 1) {
            const op = affected[0];
            if (!op) throw new Error('Expected one affected operator');
            return `Прекин во интернет мрежата на ${op.name} (${formatPercentComma(op.availabilityPct)} достапност).`;
        }
        return `Прекин во интернет мрежата кај: ${params.affectedList}.`;
    }
}
