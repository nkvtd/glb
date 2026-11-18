import type { IodaSignalMetric } from '../../../../core/types/ioda.js';
import {
    type IodaSignalSeries,
    iodaSignalsResponseSchema,
} from '../../../../core/validation/ioda.js';
import { median } from './math.js';

export function flattenIodaSignals(value: unknown): IodaSignalSeries[] {
    const body = iodaSignalsResponseSchema.parse(value);
    if (body.error !== null)
        throw new Error(`IODA request failed: ${body.error}`);
    return (body.data ?? []).flat();
}

export function metricForIodaSeries(
    series: IodaSignalSeries[],
): IodaSignalMetric | null {
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

export function latestIodaTimestamp(series: IodaSignalSeries[]): number | null {
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

export function computeIodaAvailabilityPct(
    bgp: IodaSignalMetric | null,
    ping: IodaSignalMetric | null,
    bgpFloor: number,
): number {
    const hasBgp = bgp !== null && bgp.baseline >= bgpFloor;
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
