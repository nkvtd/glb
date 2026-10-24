import type { MeteoalarmReportInsert } from '../../../core/types/meteoalarm.js';
import {
    type MeteoalarmInfo,
    type MeteoalarmWarningWrapper,
    meteoalarmResponseSchema,
} from '../../../core/validation/meteoalarm.js';
import type { MunicipalityResolver } from '../resolver.js';
import type { ScrapingStrategy } from '../strategy.interface.js';

const AWARENESS_TYPES_MK: Record<
    number,
    { title: string; instrumental: string }
> = {
    1: { title: 'Силен ветер', instrumental: 'силен ветер' },
    2: { title: 'Снег и голомразица', instrumental: 'снег и голомразица' },
    3: { title: 'Грмежи и невреме', instrumental: 'грмежи и локално невреме' },
    4: {
        title: 'Густа магла',
        instrumental: 'густа магла и намалена видливост',
    },
    5: {
        title: 'Високи температури',
        instrumental: 'екстремно високи температури',
    },
    6: {
        title: 'Ниски температури',
        instrumental: 'екстремно ниски температури и голомразица',
    },
    7: { title: 'Крајбрежни појави', instrumental: 'опасни крајбрежни појави' },
    8: {
        title: 'Опасност од шумски пожари',
        instrumental: 'зголемена опасност од шумски пожари',
    },
    9: { title: 'Опасност од лавини', instrumental: 'опасност од лавини' },
    10: {
        title: 'Обилни врнежи од дожд',
        instrumental: 'обилни врнежи од дожд',
    },
    12: { title: 'Опасност од поплави', instrumental: 'опасност од поплави' },
    13: {
        title: 'Обилен дожд и поплави',
        instrumental: 'обилни врнежи од дожд и можна појава на поплави',
    },
};

const AWARENESS_LEVELS_MK: Record<
    number,
    { colorAdjective: string; severityDesc: string }
> = {
    2: {
        colorAdjective: 'жолто',
        severityDesc: 'потенцијално опасни временски непогоди',
    },
    3: {
        colorAdjective: 'портокалово',
        severityDesc: 'опасни временски непогоди',
    },
    4: {
        colorAdjective: 'црвено',
        severityDesc: 'екстремно опасни временски непогоди',
    },
};

export class MeteoalarmStrategy
    implements
        ScrapingStrategy<MeteoalarmWarningWrapper[], MeteoalarmReportInsert>
{
    readonly source = 'meteoalarm';
    readonly url: string;
    readonly category = 'weather' as const;
    readonly target = 'reports';
    readonly schedule: string;
    private readonly resolver: MunicipalityResolver;

    constructor(url: string, schedule: string, resolver: MunicipalityResolver) {
        this.url = url;
        this.schedule = schedule;
        this.resolver = resolver;
    }

    async fetch(): Promise<MeteoalarmWarningWrapper[]> {
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
        const parsed = meteoalarmResponseSchema.parse(data);

        return parsed.warnings;
    }

    async parse(
        warnings: MeteoalarmWarningWrapper[],
    ): Promise<MeteoalarmReportInsert[]> {
        const now = new Date();
        const results: MeteoalarmReportInsert[] = [];

        for (const { uuid, alert } of warnings) {
            if (alert.status.toLowerCase() !== 'actual') continue;

            const enInfo =
                alert.info.find((i) =>
                    i.language?.toLowerCase().startsWith('en'),
                ) ?? alert.info[0];
            const mkInfo = alert.info.find((i) =>
                i.language?.toLowerCase().startsWith('mk'),
            );

            if (!enInfo) continue;

            const awarenessLevel = this.parseAwarenessLevel(enInfo);
            const awarenessType = this.parseAwarenessType(enInfo);

            const startsAt = enInfo.onset ?? enInfo.effective ?? alert.sent;
            const endsAt =
                enInfo.expires && enInfo.expires > startsAt
                    ? enInfo.expires
                    : null;

            const isCancelled = alert.msgType.toLowerCase() === 'cancel';
            const isGreen = awarenessLevel?.code === 1;

            const status =
                isCancelled || (endsAt !== null && now >= endsAt)
                    ? 'ended'
                    : isGreen
                      ? 'omitted'
                      : now < startsAt
                        ? 'scheduled'
                        : 'ongoing';

            const validMkText = this.extractValidCyrillicText(
                mkInfo?.description,
            );

            const eventMeta = awarenessType
                ? AWARENESS_TYPES_MK[awarenessType.code]
                : undefined;

            const eventTitle =
                eventMeta?.title ?? this.translateEventFallback(enInfo.event);
            const eventInstrumental =
                eventMeta?.instrumental ?? eventTitle.toLowerCase();

            for (const area of enInfo.area) {
                const nutsCode =
                    area.geocode
                        .find((g) => g.valueName.toUpperCase() === 'NUTS3')
                        ?.value.trim()
                        .toUpperCase() ?? null;

                const regionMunicipalities =
                    this.resolver.resolveRegion(nutsCode);

                const targets =
                    regionMunicipalities.length > 0
                        ? regionMunicipalities
                        : [
                              {
                                  code: this.resolver.resolveText(
                                      area.areaDesc,
                                  ),
                                  nameMk: area.areaDesc.trim(),
                              },
                          ];

                for (const target of targets) {
                    const locationLabel = target.nameMk;
                    const title = `${eventTitle}: ${locationLabel}`;
                    const description = this.formatDescription({
                        locationLabel,
                        eventInstrumental,
                        levelCode: awarenessLevel?.code ?? null,
                        validMkText,
                    });

                    const externalId = target.code
                        ? `${alert.identifier}-${target.code}`
                        : `${alert.identifier}-${locationLabel}`;

                    results.push({
                        externalId,
                        source: this.source,
                        category: this.category,
                        title,
                        description,
                        municipalityCode: target.code,
                        locationLabel,
                        status,
                        observedAt: now,
                        startsAt,
                        endsAt,
                        rawPayload: {
                            uuid,
                            identifier: alert.identifier,
                            sender: alert.sender,
                            sentAt: alert.sent,
                            status: alert.status,
                            msgType: alert.msgType,
                            event: enInfo.event,
                            severity: enInfo.severity ?? null,
                            urgency: enInfo.urgency ?? null,
                            certainty: enInfo.certainty ?? null,
                            awarenessLevel,
                            awarenessType,
                            regionCode: nutsCode,
                            areaDesc: area.areaDesc,
                            headline: enInfo.headline ?? null,
                            description:
                                validMkText ?? enInfo.description ?? null,
                            web: enInfo.web ?? null,
                        },
                    });
                }
            }
        }

        return results;
    }

    private formatDescription(params: {
        locationLabel: string;
        eventInstrumental: string;
        levelCode: number | null;
        validMkText: string | null;
    }): string {
        const levelMeta = params.levelCode
            ? AWARENESS_LEVELS_MK[params.levelCode]
            : undefined;

        const baseSentence = levelMeta
            ? `Издадено е ${levelMeta.colorAdjective} метео предупредување за ${params.eventInstrumental} во ${params.locationLabel} (${levelMeta.severityDesc}).`
            : `Издадено е метео предупредување за ${params.eventInstrumental} во ${params.locationLabel}.`;

        if (params.validMkText) {
            return `${baseSentence} ${params.validMkText}`;
        }

        return `${baseSentence} Се препорачува внимателност и следење на состојбата од страна на УХМР.`;
    }

    private parseAwarenessLevel(info: MeteoalarmInfo): {
        code: number;
        color: string;
        label: string;
    } | null {
        const raw = info.parameter.find(
            (p) => p.valueName.toLowerCase() === 'awareness_level',
        )?.value;
        if (!raw) return null;

        const parts = raw.split(';').map((s) => s.trim());
        const code = Number(parts[0]);
        if (!Number.isInteger(code)) return null;

        return {
            code,
            color: parts[1] ?? 'unknown',
            label: parts[2] ?? 'Unknown',
        };
    }

    private parseAwarenessType(info: MeteoalarmInfo): {
        code: number;
        label: string;
    } | null {
        const raw = info.parameter.find(
            (p) => p.valueName.toLowerCase() === 'awareness_type',
        )?.value;
        if (!raw) return null;

        const parts = raw.split(';').map((s) => s.trim());
        const code = Number(parts[0]);
        if (!Number.isInteger(code)) return null;

        return {
            code,
            label: parts[1] ?? info.event,
        };
    }

    private extractValidCyrillicText(text?: string | null): string | null {
        if (!text) return null;
        const trimmed = text.trim();
        if (!/\p{Script=Cyrillic}/u.test(trimmed)) return null;
        return trimmed.endsWith('.') ? trimmed : `${trimmed}.`;
    }

    private translateEventFallback(event: string): string {
        const lower = event.toLowerCase();
        if (lower.includes('thunder')) return 'Грмежи и невреме';
        if (lower.includes('wind')) return 'Силен ветер';
        if (lower.includes('rain')) return 'Обилни врнежи од дожд';
        if (lower.includes('snow') || lower.includes('ice'))
            return 'Снег и голомразица';
        if (lower.includes('fog')) return 'Густа магла';
        if (lower.includes('high') && lower.includes('temp'))
            return 'Високи температури';
        if (lower.includes('low') && lower.includes('temp'))
            return 'Ниски температури';
        if (lower.includes('flood')) return 'Опасност од поплави';
        if (lower.includes('fire')) return 'Опасност од шумски пожари';
        return 'Метеоролошко предупредување';
    }
}
