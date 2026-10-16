import { createHash } from 'node:crypto';
import type { EvnReportInsert } from '../../../core/types/evn.js';
import {
    type EvnItem,
    evnResponseSchema,
} from '../../../core/validation/evn.js';
import type { MunicipalityResolver } from '../resolver.js';
import type { ScrapingStrategy } from '../strategy.interface.js';

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
        const response = await fetch(this.url, {
            signal: AbortSignal.timeout(15_000),
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(
                `Fetch failed with status code ${response.status}: ${errorText}`,
            );
        }

        const data = await response.json();

        return evnResponseSchema.parse(data);
    }

    async parse(items: EvnItem[]): Promise<EvnReportInsert[]> {
        const now = new Date();

        return items.map((item) => {
            const place = item.nasMesto.trim();
            const address = item.adresa.trim();
            const type = item.tipPrekin.trim();
            const voltageLevel = item.napNivo.trim();

            const externalId = createHash('sha256')
                .update(
                    `${item.kecId}|${type}|${place}|${address}|${item.pocetok.toISOString()}|${item.kraj.toISOString()}|${voltageLevel}`,
                )
                .digest('hex')
                .slice(0, 32);

            const endsAt = item.kraj > item.pocetok ? item.kraj : null;

            const status =
                now < item.pocetok
                    ? 'scheduled'
                    : !endsAt || now <= endsAt
                      ? 'ongoing'
                      : 'ended';

            const locationLabel = this.formatLocation(place);
            const code =
                this.resolver.resolve(locationLabel) ??
                this.resolver.resolve(place);

            return {
                externalId,
                source: this.source,
                category: this.category,
                title: `${type}: ${locationLabel}`,
                description: address,
                municipalityCode: code,
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

    private formatLocation(raw: string): string {
        const withoutParens = raw.replace(/\s*\([^)]+\)\s*$/, '').trim();

        if (withoutParens === 'МАВРОВО-РОСТУШЕ') {
            return 'Маврово и Ростуше';
        }

        const match = withoutParens.match(/^(.+?)(?<!\s)-(?!\s)(.+)$/);
        const [, rawMunicipality, rawSettlementPart] = match ?? [];

        if (!rawMunicipality || !rawSettlementPart) {
            return this.toTitleCase(withoutParens.replace(/\s*-\s*/g, '-'));
        }

        const municipality = this.toTitleCase(
            rawMunicipality.replace(/\s*-\s*/g, '-').trim(),
        );

        const rawSettlement = rawSettlementPart
            .replace(/^СКОПЈЕ-/i, '')
            .replace(/\s*-\s*/g, ' / ')
            .trim();

        const settlement = this.toTitleCase(rawSettlement);

        if (!settlement || settlement === municipality) {
            return municipality;
        }

        return `${settlement}, ${municipality}`;
    }

    private toTitleCase(text: string): string {
        return text
            .toLowerCase()
            .replace(
                /\p{L}+/gu,
                (word) => word.charAt(0).toUpperCase() + word.slice(1),
            );
    }
}
