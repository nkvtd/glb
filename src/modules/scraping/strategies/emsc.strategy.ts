import type { EmscReportInsert } from '../../../core/types/emsc.js';
import {
    type EmscFeature,
    emscResponseSchema,
} from '../../../core/validation/emsc.js';
import type { MunicipalityResolver } from '../resolver.js';
import type { ScrapingStrategy } from '../strategy.interface.js';
import { fetchJsonOrNull } from './util/fetch.js';
import { formatEwktPoint } from './util/geo.js';

const LOOKBACK_WINDOW_MS = 24 * 60 * 60 * 1000;
const ACTIVE_WINDOW_MS = 60 * 60 * 1000;
const CROSS_BORDER_MIN_MAG = 3.0;

export class EmscStrategy
    implements ScrapingStrategy<EmscFeature[], EmscReportInsert>
{
    readonly source = 'emsc-csem';
    readonly url: string;
    readonly category = 'earthquake' as const;
    readonly target = 'reports';
    readonly schedule: string;
    private readonly resolver: MunicipalityResolver;

    constructor(url: string, schedule: string, resolver: MunicipalityResolver) {
        this.url = url;
        this.schedule = schedule;
        this.resolver = resolver;
    }

    async fetch(): Promise<EmscFeature[]> {
        const requestUrl = new URL(this.url);
        if (!requestUrl.searchParams.has('start')) {
            requestUrl.searchParams.set(
                'start',
                new Date(Date.now() - LOOKBACK_WINDOW_MS).toISOString(),
            );
        }

        const parsed = await fetchJsonOrNull(
            requestUrl.toString(),
            emscResponseSchema,
        );
        return parsed?.features ?? [];
    }

    async parse(items: EmscFeature[]): Promise<EmscReportInsert[]> {
        const now = new Date();
        const results: EmscReportInsert[] = [];

        for (const item of items) {
            const p = item.properties;
            if (!Number.isFinite(p.lon) || !Number.isFinite(p.lat)) continue;

            const resolved = await this.resolver.resolveCoords(p.lon, p.lat);
            if (!resolved && p.mag < CROSS_BORDER_MIN_MAG) continue;

            const isDomestic = resolved !== null;
            const municipalityCode = resolved?.code ?? null;
            const locationLabel =
                resolved?.name ?? this.formatBorderRegion(p.flynn_region);

            const magFormatted = p.mag.toFixed(1);
            const magnitudeType = p.magtype.trim().toUpperCase() || 'ML';
            const depthKm = Number(Math.abs(p.depth).toFixed(1));
            const isRecent =
                now.getTime() - p.time.getTime() <= ACTIVE_WINDOW_MS;

            const description = this.formatDescription({
                locationLabel,
                flynnRegion: p.flynn_region,
                isDomestic,
                magnitude: p.mag,
                magFormatted,
                magnitudeType,
                depthKm,
            });

            results.push({
                externalId: this.buildExternalId(p.unid),
                source: this.source,
                category: this.category,
                title: this.formatTitle(p.mag, locationLabel),
                description,
                municipalityCode,
                locationLabel,
                geom: formatEwktPoint(p.lon, p.lat),
                status: isRecent ? 'ongoing' : 'ended',
                observedAt: now,
                startsAt: p.time,
                endsAt: p.time,
                rawPayload: {
                    unid: p.unid.trim(),
                    sourceId: p.source_id.trim(),
                    sourceCatalog: p.source_catalog.trim(),
                    authority: p.auth.trim(),
                    eventType: p.evtype?.trim() || null,
                    magnitude: p.mag,
                    magnitudeType,
                    depthKm,
                    flynnRegion: p.flynn_region.trim(),
                    occurredAt: p.time,
                    lastUpdatedAt: p.lastupdate,
                    coordinates: { lng: p.lon, lat: p.lat },
                },
            });
        }

        return results;
    }

    private buildExternalId(unid: string): string {
        return unid.trim();
    }

    private formatTitle(magnitude: number, locationLabel: string): string {
        return `${this.formatTitlePrefix(magnitude)}: ${locationLabel}`;
    }

    private formatTitlePrefix(magnitude: number): string {
        if (magnitude < 3.0) return 'Слаб земјотрес';
        if (magnitude < 4.0) return 'Умерен земјотрес';
        if (magnitude < 5.0) return 'Посилен земјотрес';
        return 'Силен земјотрес';
    }

    private getMagnitudeAdjective(magnitude: number): string {
        if (magnitude < 3.0) return 'слаб';
        if (magnitude < 4.0) return 'умерен';
        if (magnitude < 5.0) return 'посилен';
        return 'силен';
    }

    private formatDescription(params: {
        locationLabel: string;
        flynnRegion: string;
        isDomestic: boolean;
        magnitude: number;
        magFormatted: string;
        magnitudeType: string;
        depthKm: number;
    }): string {
        const adjective = this.getMagnitudeAdjective(params.magnitude);
        const borderCountry = this.getBorderCountryName(params.flynnRegion);

        const locationPhrase = params.isDomestic
            ? `со епицентар во подрачјето на ${params.locationLabel}`
            : borderCountry
              ? `со епицентар во пограничниот регион на ${borderCountry}`
              : 'со епицентар во пограничниот регион';

        const firstSentence = `Регистриран е ${adjective} земјотрес ${locationPhrase}, со јачина од ${params.magFormatted} степени (${params.magnitudeType}) и длабочина од ${params.depthKm} km.`;

        const secondSentence = !params.isDomestic
            ? 'Потресот може да биде почувствуван и во пограничните делови на Македонија.'
            : params.magnitude < 3.0
              ? 'Потресот е со слаб интензитет и обично се чувствува само во непосредна близина на епицентарот.'
              : params.magnitude < 4.5
                ? 'Потресот може да биде почувствуван околу епицентарот, но и во околните места.'
                : 'Потресот е со значителен интензитет и може да биде почувствуван на значително пошироко подрачје.';

        return `${firstSentence} ${secondSentence}`;
    }

    private getBorderCountryName(flynnRegion: string): string | null {
        const upper = flynnRegion.trim().toUpperCase();
        if (upper.includes('ALBANIA')) return 'Албанија';
        if (upper.includes('GREECE')) return 'Грција';
        if (upper.includes('BULGARIA')) return 'Бугарија';
        if (upper.includes('SERBIA')) return 'Србија';
        if (upper.includes('KOSOVO')) return 'Косово';
        return null;
    }

    private formatBorderRegion(flynnRegion: string): string {
        const country = this.getBorderCountryName(flynnRegion);
        return country ? `${country} (пограничен регион)` : 'Граничен регион';
    }
}
