import type {
    WorldFiresHotspotSummary,
    WorldFiresReportInsert,
} from '../../../core/types/worldfires.js';
import {
    type WorldFiresHotspot,
    worldFiresHotspotsResponseSchema,
} from '../../../core/validation/worldfires.js';
import type { MunicipalityResolver } from '../resolver.js';
import type { ScrapingStrategy } from '../strategy.interface.js';

const ACTIVE_WINDOW_MS = 6 * 60 * 60 * 1000;
const CROSS_BORDER_MIN_FRP_MW = 10.0;
const CLUSTER_RADIUS_DEG = 0.015;

type HotspotCluster = {
    municipalityCode: string | null;
    locationLabel: string;
    isDomestic: boolean;
    detections: ClusterDetection[];
};

type ClusterDetection = WorldFiresHotspotSummary & {
    timeUtc: Date;
    satellite: string;
    sensor: string;
};

type SatellitePass = {
    timeUtc: Date;
    detections: ClusterDetection[];
    totalFrpMw: number;
};

export class WorldFiresStrategy
    implements ScrapingStrategy<WorldFiresHotspot[], WorldFiresReportInsert>
{
    readonly source = 'worldfires-hotspots';
    readonly url: string;
    readonly category = 'wildfire' as const;
    readonly target = 'reports';
    readonly schedule: string;
    private readonly resolver: MunicipalityResolver;

    constructor(url: string, schedule: string, resolver: MunicipalityResolver) {
        this.url = url;
        this.schedule = schedule;
        this.resolver = resolver;
    }

    async fetch(): Promise<WorldFiresHotspot[]> {
        const response = await fetch(this.url, {
            headers: { Accept: 'application/json' },
            signal: AbortSignal.timeout(15_000),
        });

        if (response.status === 204) {
            return [];
        }

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(
                `Fetch failed with status code ${response.status}: ${errorText}`,
            );
        }

        return worldFiresHotspotsResponseSchema.parse(await response.json())
            .data;
    }

    async parse(items: WorldFiresHotspot[]): Promise<WorldFiresReportInsert[]> {
        const now = new Date();
        const clusters: HotspotCluster[] = [];

        for (const item of items) {
            if (
                !Number.isFinite(item.lon) ||
                !Number.isFinite(item.lat) ||
                !Number.isFinite(item.frp_mw) ||
                item.frp_mw < 0
            ) {
                continue;
            }

            const resolved = await this.resolver.resolveCoords(
                item.lon,
                item.lat,
            );

            const isDomestic = resolved !== null;
            const municipalityCode = resolved?.code ?? null;
            const locationLabel = resolved?.name ?? 'Пограничен регион';
            const satellite = item.satellite.trim() || 'VIIRS';
            const sensor = item.sensor.trim().toUpperCase() || 'VIIRS';

            const detection: ClusterDetection = {
                timeUtc: item.time_utc,
                lat: item.lat,
                lng: item.lon,
                frpMw: item.frp_mw,
                satellite,
                sensor,
            };

            const matchingClusters = clusters.filter(
                (c) =>
                    c.locationLabel === locationLabel &&
                    c.detections.some(
                        (h) =>
                            Math.abs(
                                h.timeUtc.getTime() - item.time_utc.getTime(),
                            ) <= ACTIVE_WINDOW_MS &&
                            Math.abs(h.lat - item.lat) <= CLUSTER_RADIUS_DEG &&
                            Math.abs(h.lng - item.lon) <= CLUSTER_RADIUS_DEG,
                    ),
            );

            const [primaryCluster, ...secondaryClusters] = matchingClusters;
            if (primaryCluster) {
                primaryCluster.detections.push(detection);

                for (const cluster of secondaryClusters) {
                    primaryCluster.detections.push(...cluster.detections);
                    const clusterIndex = clusters.indexOf(cluster);
                    if (clusterIndex !== -1) clusters.splice(clusterIndex, 1);
                }
            } else {
                clusters.push({
                    municipalityCode,
                    locationLabel,
                    isDomestic,
                    detections: [detection],
                });
            }
        }

        const results: WorldFiresReportInsert[] = [];

        for (const cluster of clusters) {
            cluster.detections.sort(
                (a, b) =>
                    a.timeUtc.getTime() - b.timeUtc.getTime() ||
                    a.lat - b.lat ||
                    a.lng - b.lng ||
                    a.frpMw - b.frpMw,
            );

            const passes: SatellitePass[] = [];
            for (const detection of cluster.detections) {
                let pass = passes.at(-1);
                if (pass?.timeUtc.getTime() !== detection.timeUtc.getTime()) {
                    pass = {
                        timeUtc: detection.timeUtc,
                        detections: [],
                        totalFrpMw: 0,
                    };
                    passes.push(pass);
                }
                pass.detections.push(detection);
                pass.totalFrpMw += detection.frpMw;
            }

            const firstPass = passes[0];
            if (!firstPass) continue;

            const startedAt = firstPass.timeUtc;
            const ignitionAnchor = firstPass.detections[0];
            if (!ignitionAnchor) continue;

            const escalations: SatellitePass[] = [];
            let highestTier = 0;
            for (const pass of passes) {
                if (
                    !cluster.isDomestic &&
                    pass.totalFrpMw < CROSS_BORDER_MIN_FRP_MW
                ) {
                    continue;
                }
                const tier = this.getIntensityTier(pass.totalFrpMw);
                if (tier > highestTier) {
                    highestTier = tier;
                    escalations.push(pass);
                }
            }

            const lastPass = passes.at(-1);
            if (!lastPass) continue;
            for (let i = 0; i < escalations.length; i++) {
                const step = escalations[i];
                if (!step) continue;
                const nextEscalation = escalations[i + 1];
                const isCurrentPeak = i === escalations.length - 1;
                const isOngoing =
                    isCurrentPeak &&
                    now.getTime() - lastPass.timeUtc.getTime() <=
                        ACTIVE_WINDOW_MS;
                const hotspots: WorldFiresHotspotSummary[] =
                    step.detections.map(({ lat, lng, frpMw }) => ({
                        lat,
                        lng,
                        frpMw: Number(frpMw.toFixed(2)),
                    }));
                const count = hotspots.length;
                const totalFrpMw = step.totalFrpMw;
                const frpMw = Number(totalFrpMw.toFixed(2));
                const centroidLat = Number(
                    (
                        hotspots.reduce((sum, h) => sum + h.lat, 0) / count
                    ).toFixed(5),
                );
                const centroidLng = Number(
                    (
                        hotspots.reduce((sum, h) => sum + h.lng, 0) / count
                    ).toFixed(5),
                );
                const firstDetection = step.detections[0];
                if (!firstDetection) continue;
                const title = `${this.formatTitlePrefix(totalFrpMw)}: ${cluster.locationLabel}`;
                const description = this.formatDescription({
                    locationLabel: cluster.locationLabel,
                    isDomestic: cluster.isDomestic,
                    frpMw: totalFrpMw,
                    hotspotCount: count,
                });

                results.push({
                    externalId: this.buildExternalId(
                        startedAt,
                        ignitionAnchor.lat,
                        ignitionAnchor.lng,
                        this.getIntensityTier(totalFrpMw),
                    ),
                    source: this.source,
                    category: this.category,
                    title,
                    description,
                    municipalityCode: cluster.municipalityCode,
                    locationLabel: cluster.locationLabel,
                    geom: `SRID=4326;POINT(${centroidLng} ${centroidLat})`,
                    status: isOngoing ? 'ongoing' : 'ended',
                    observedAt: now,
                    startsAt: startedAt,
                    endsAt: !isCurrentPeak
                        ? (nextEscalation?.timeUtc ?? null)
                        : isOngoing
                          ? null
                          : lastPass.timeUtc,
                    rawPayload: {
                        detectedAt: step.timeUtc,
                        frpMw,
                        hotspotCount: count,
                        satellite: firstDetection.satellite,
                        sensor: firstDetection.sensor,
                        coordinates: { lng: centroidLng, lat: centroidLat },
                        hotspots,
                    },
                });
            }
        }

        return results;
    }

    private buildExternalId(
        timeUtc: Date,
        lat: number,
        lon: number,
        tier: 1 | 2 | 3 | 4,
    ): string {
        const compactTime = timeUtc
            .toISOString()
            .slice(0, 16)
            .replace(/[-:]/g, '');
        return `worldfires-${compactTime}Z-${lat.toFixed(3)}-${lon.toFixed(3)}-t${tier}`;
    }

    private getIntensityTier(frpMw: number): 1 | 2 | 3 | 4 {
        if (frpMw < 10.0) return 1;
        if (frpMw < 50.0) return 2;
        if (frpMw < 150.0) return 3;
        return 4;
    }

    private formatTitlePrefix(frpMw: number): string {
        if (frpMw < 10.0) return 'Пожар од помал обем';
        if (frpMw < 50.0) return 'Пожар';
        if (frpMw < 150.0) return 'Силен пожар';
        return 'Пожар од големи размери';
    }

    private getIntensityAdjective(frpMw: number): string {
        if (frpMw < 10.0) return 'слаб';
        if (frpMw < 50.0) return 'умерен';
        if (frpMw < 150.0) return 'висок';
        return 'исклучително висок';
    }

    private formatDescription(params: {
        locationLabel: string;
        isDomestic: boolean;
        frpMw: number;
        hotspotCount: number;
    }): string {
        const intensity = this.getIntensityAdjective(params.frpMw);
        const locationPhrase = params.isDomestic
            ? `во подрачјето на ${params.locationLabel}`
            : 'во пограничниот појас';

        const clusterNote =
            params.hotspotCount > 1 ? ` (${params.hotspotCount} жаришта)` : '';

        const firstSentence = `Детектиран е пожар на отворен простор со ${intensity} интензитет ${locationPhrase}${clusterNote}.`;

        const secondSentence = !params.isDomestic
            ? 'Огненото жариште е во непосредна близина на државната граница со ризик од прекугранично проширување.'
            : params.frpMw < 10.0
              ? 'Станува збор за помало локализирано жариште или палење на ниска вегетација.'
              : params.frpMw < 50.0
                ? 'Станува збор за активно жариште зафатено со сува трева, грмушки или шумски појас.'
                : 'Станува збор за сериозен шумски пожар со голема топлинска моќност и брзо ширење.';

        return `${firstSentence} ${secondSentence}`;
    }
}
