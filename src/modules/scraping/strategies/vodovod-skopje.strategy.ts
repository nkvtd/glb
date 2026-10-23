import type { VodovodSkopjeReportInsert } from '../../../core/types/vodovod-skopje.js';
import {
    type VodovodSkopjeFeature,
    vodovodSkopjeResponseSchema,
} from '../../../core/validation/vodovod-skopje.js';
import type { MunicipalityResolver } from '../resolver.js';
import type { ScrapingStrategy } from '../strategy.interface.js';

export class VodovodSkopjeStrategy
    implements
        ScrapingStrategy<VodovodSkopjeFeature[], VodovodSkopjeReportInsert>
{
    readonly source = 'vodovod-skopje';
    readonly url: string;
    readonly category = 'water' as const;
    readonly target = 'reports';
    readonly schedule: string;
    private readonly resolver: MunicipalityResolver;

    constructor(url: string, schedule: string, resolver: MunicipalityResolver) {
        this.url = url;
        this.schedule = schedule;
        this.resolver = resolver;
    }

    async fetch(): Promise<VodovodSkopjeFeature[]> {
        const response = await fetch(this.url, {
            signal: AbortSignal.timeout(60_000),
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(
                `Fetch failed with status code ${response.status}: ${errorText}`,
            );
        }

        const data = await response.json();
        const parsed = vodovodSkopjeResponseSchema.parse(data);

        return parsed.features;
    }

    async parse(
        items: VodovodSkopjeFeature[],
    ): Promise<VodovodSkopjeReportInsert[]> {
        const now = new Date();

        const filteredItems = items.filter(
            ({ attributes: a }) => a.title?.trim().toUpperCase() !== 'РАЗ',
        );

        return Promise.all(
            filteredItems.map(async ({ attributes: a, geometry }) => {
                const rawMunicipality = a.Opstina.trim();
                const rawStreet = a.Ulica.replace(/[“”"]/g, '').trim();
                const streetNumber = a.adresaBrojDefekt?.trim() || null;

                const municipality = this.toTitleCase(rawMunicipality);
                const street = this.toTitleCase(rawStreet);
                const defectType = this.capitalizeFirst(a.vidDefektName.trim());

                const streetAddress = [street, streetNumber]
                    .filter(Boolean)
                    .join(' ');
                const locationLabel = [streetAddress, municipality]
                    .filter(Boolean)
                    .join(', ');

                const startsAt = a.datumZatvorenaVoda ?? a.acceptanceDate;

                // status 0 = open, status 1 = cancelled, status 2 = completed
                const isClosed = a.status === 1 || a.status === 2;
                const rawEndsAt =
                    a.datumPustenaVoda ?? (isClosed ? a.statusVreme : null);
                const endsAt =
                    rawEndsAt && rawEndsAt >= startsAt ? rawEndsAt : null;

                const status =
                    isClosed || (endsAt !== null && now >= endsAt)
                        ? 'ended'
                        : now < startsAt
                          ? 'scheduled'
                          : 'ongoing';

                const description = this.formatDescription({
                    defectName: a.vidDefektName.trim(),
                    interventionName: a.vidIntervencijaName?.trim() || null,
                    street,
                    streetNumber,
                    municipality,
                    defectInfo: a.defectInfo?.trim() || null,
                    locationNote: a.lokacija?.trim() || null,
                    urgency: a.itnostString?.trim() || null,
                });

                const geomWkt = geometry
                    ? `SRID=4326;POINT(${geometry.x} ${geometry.y})`
                    : null;

                const code =
                    this.resolver.resolveText(rawMunicipality) ??
                    this.resolver.resolveText(municipality) ??
                    (geometry
                        ? await this.resolver.resolveCoords(
                              geometry.x,
                              geometry.y,
                          )
                        : null);

                return {
                    externalId: String(a.idINT),
                    source: this.source,
                    category: this.category,
                    title: `${defectType}: ${municipality}`,
                    description: description,
                    municipalityCode: code,
                    locationLabel: locationLabel,
                    geom: geomWkt,
                    status: status,
                    observedAt: now,
                    startsAt: startsAt,
                    endsAt: endsAt,
                    rawPayload: {
                        interventionId: a.idINT,
                        archiveNumber: a.archiveNumber?.trim() || null,
                        municipality: rawMunicipality,
                        street: rawStreet,
                        streetNumber: streetNumber,
                        locationNote: a.lokacija?.trim() || null,
                        defectTypeId: a.vidDefektId ?? null,
                        defectType: a.vidDefektName.trim(),
                        interventionTypeId: a.vidIntervencijaId ?? null,
                        interventionType: a.vidIntervencijaName?.trim() || null,
                        defectInfo: a.defectInfo?.trim() || null,
                        urgency: a.itnostString?.trim() || null,
                        notifiedOutage: a.izvesteniPrekin?.trim() || null,
                        rawStatus: a.status,
                        acceptedAt: a.acceptanceDate,
                        statusChangedAt: a.statusVreme ?? null,
                        waterShutoffAt: a.datumZatvorenaVoda ?? null,
                        waterRestoredAt: a.datumPustenaVoda ?? null,
                        waterShutoffType: a.zatvorenaVodaTip ?? null,
                        hydroforPowerOutage: a.prekinStrujaHidrofor === 1,
                        inspectionCompleted: a.naprevenUvid === 1,
                        coordinates: geometry
                            ? { lng: geometry.x, lat: geometry.y }
                            : null,
                    },
                };
            }),
        );
    }

    private formatDescription(params: {
        defectName: string;
        interventionName: string | null;
        street: string;
        streetNumber: string | null;
        municipality: string;
        defectInfo: string | null;
        locationNote: string | null;
        urgency: string | null;
    }): string {
        const hasStreetPrefix = /^(Булевар|Улица|Ул\.|Бул\.)/i.test(
            params.street,
        );
        const formattedStreet = hasStreetPrefix
            ? params.street
            : `ул. ${params.street}`;
        const fullAddress = params.streetNumber
            ? `${formattedStreet} бр. ${params.streetNumber}`
            : formattedStreet;

        const lowerDefect =
            params.defectName.charAt(0).toLowerCase() +
            params.defectName.slice(1);
        const notes = [params.defectInfo, params.locationNote]
            .filter(Boolean)
            .join(', ');
        const notesSuffix = notes ? ` (${notes})` : '';

        const firstSentence = lowerDefect.includes('дефект')
            ? `Пријавен е ${lowerDefect} на ${fullAddress} во ${params.municipality}${notesSuffix}.`
            : `Пријавен е проблем (${lowerDefect}) на ${fullAddress} во ${params.municipality}${notesSuffix}.`;

        const urgencyText =
            params.urgency?.toLowerCase() === 'итно'
                ? ' со итен приоритет'
                : '';

        if (params.interventionName?.includes('отпушување')) {
            const method = params.interventionName
                .split('-')[1]
                ?.trim()
                .toLowerCase();
            return `${firstSentence} Се врши ${method || 'интервенција на канализациската мрежа'}${urgencyText}.`;
        }

        return `${firstSentence} Екипите вршат интервенција на водоводната мрежа${urgencyText}.`;
    }

    private capitalizeFirst(text: string): string {
        return text.charAt(0).toUpperCase() + text.slice(1);
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
