import type { EvnReportInsert } from '../../../core/types/evn.js';
import {
    type EvnItem,
    evnResponseSchema,
} from '../../../core/validation/evn.js';
import type { MunicipalityResolver } from '../resolver.js';
import type { ScrapingStrategy } from '../strategy.interface.js';
import { fetchJson } from './util/fetch.js';
import { hashExternalId } from './util/hash.js';
import { ensurePeriod, toTitleCase } from './util/text.js';
import { deriveLifecycleStatus } from './util/time.js';

export class EvnStrategy
    implements ScrapingStrategy<EvnItem[], EvnReportInsert>
{
    readonly source = 'evn';
    readonly url: string;
    readonly category = 'power' as const;
    readonly target = 'reports';
    readonly schedule: string;
    private readonly resolver: MunicipalityResolver;

    constructor(url: string, schedule: string, resolver: MunicipalityResolver) {
        this.url = url;
        this.schedule = schedule;
        this.resolver = resolver;
    }

    async fetch(): Promise<EvnItem[]> {
        return fetchJson(this.url, evnResponseSchema);
    }

    async parse(items: EvnItem[]): Promise<EvnReportInsert[]> {
        const now = new Date();

        return items.map((item) => {
            const place = item.nasMesto.trim();
            const address = item.adresa.trim();
            const type = item.tipPrekin.trim();
            const voltageLevel = item.napNivo.trim();

            const endsAt = item.kraj > item.pocetok ? item.kraj : null;
            const status = deriveLifecycleStatus(now, item.pocetok, endsAt);

            const locationLabel = this.formatLocation(place);

            return {
                externalId: this.buildExternalId(
                    item,
                    type,
                    place,
                    address,
                    voltageLevel,
                ),
                source: this.source,
                category: this.category,
                title: this.formatTitle(type, locationLabel),
                description: this.formatDescription(address),
                municipalityCode:
                    this.resolver.resolveText(locationLabel) ??
                    this.resolver.resolveText(place),
                locationLabel: locationLabel,
                status: status,
                observedAt: now,
                startsAt: item.pocetok,
                endsAt: endsAt,
                rawPayload: {
                    interruptionId: item.prekinID,
                    distributionCenterId: item.kecId,
                    interruptionType: type,
                    place: place,
                    address: address,
                    start: item.pocetok,
                    end: item.kraj,
                    voltageLevel: voltageLevel,
                },
            };
        });
    }

    private buildExternalId(
        item: EvnItem,
        type: string,
        place: string,
        address: string,
        voltageLevel: string,
    ): string {
        return hashExternalId(
            item.kecId,
            type,
            place,
            address,
            item.pocetok.toISOString(),
            item.kraj.toISOString(),
            voltageLevel,
        );
    }

    private formatTitle(type: string, locationLabel: string): string {
        return `${type}: ${locationLabel}`;
    }

    private formatLocation(raw: string): string {
        const withoutParens = raw.replace(/\s*\([^)]+\)\s*$/, '').trim();

        if (withoutParens === 'МАВРОВО-РОСТУШЕ') {
            return 'Маврово и Ростуша';
        }

        const match = withoutParens.match(/^(.+?)(?<!\s)-(?!\s)(.+)$/);
        const [, rawMunicipality, rawSettlementPart] = match ?? [];

        if (!rawMunicipality || !rawSettlementPart) {
            return toTitleCase(withoutParens.replace(/\s*-\s*/g, '-'));
        }

        const municipality = toTitleCase(
            rawMunicipality.replace(/\s*-\s*/g, '-').trim(),
        );

        const rawSettlement = rawSettlementPart
            .replace(/^СКОПЈЕ-/i, '')
            .replace(/\s*-\s*/g, ' / ')
            .trim();

        const settlement = toTitleCase(rawSettlement);

        if (!settlement || settlement === municipality) {
            return municipality;
        }

        return `${settlement}, ${municipality}`;
    }

    private formatDescription(raw: string): string {
        const cleaned = ensurePeriod(
            raw
                .replace(/,(?!\s|\d)/g, ', ')
                .replace(/\s+/g, ' ')
                .trim(),
        );

        const isProse =
            /^(поради|заради|технички|потребно|ќе останат|потрошувачите|корисниците|без |прекини|во )/iu.test(
                cleaned,
            );

        return isProse
            ? cleaned
            : `Без електрична енергија ќе останат корисниците во: ${cleaned}`;
    }
}
