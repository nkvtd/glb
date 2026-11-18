import type {
    VodovodPrilepReportInsert,
    VodovodPrilepSupply,
} from '../../../core/types/vodovod-prilep.js';
import {
    type VodovodPrilepItem,
    vodovodPrilepResponseSchema,
} from '../../../core/validation/vodovod-prilep.js';
import type { ScrapingStrategy } from '../strategy.interface.js';
import { BROWSER_JSON_HEADERS, fetchJson } from './util/fetch.js';
import { hashExternalId } from './util/hash.js';
import { decodeHtmlText, ensurePeriod } from './util/text.js';
import {
    buildLocalWindow,
    deriveLifecycleStatus,
    extractIsoDay,
} from './util/time.js';

const PRILEP_MUNICIPALITY_CODE = 'MK0050800';

const ABNORMAL_SUPPLY_RE =
    /нарушено|намален|заматување|неисправна|забранет|не\s+ја\s+користат|не\s+се\s+користи|преврива|дефект|прекин|проблем/iu;

const EMERGENCY_NOTICE_RE =
    /прекин\s+во\s+водоснабдувањето|водоснабдувањето\s+ќе\s+биде\s+нарушено|настанат\s+дефект|заматување\s+на\s+водата|не\s+се\s+користи\s+за\s+пиење|да\s+не\s+ја\s+користат|неисправна/iu;

const ADMIN_IGNORE_RE =
    /јавен\s+повик|надзорен\s+одбор|управен\s+одбор|демант|подмирување\s+на\s+сметките|контакт\s+број/iu;

const INLINE_LOCATION_RE =
    /(?:^|\s)(?:на|од|во|за\s+жителите\s+на)\s+((?:ул\.|улица|бул\.|булевар|нас\.|населба|н\.м\.|м\.в\.|с\.|село|реон)\s*[^,.;–—]+?)(?=\s+(?:да\s+не|поради|ќе|водоснабдувањето|граѓаните)(?=\s|$)|[,.;–—]|$)/iu;

export class VodovodPrilepStrategy
    implements ScrapingStrategy<VodovodPrilepItem[], VodovodPrilepReportInsert>
{
    readonly source = 'vodovod-prilep';
    readonly url: string;
    readonly category = 'water' as const;
    readonly target = 'reports';
    readonly schedule: string;

    constructor(url: string, schedule: string) {
        this.url = url;
        this.schedule = schedule;
    }

    async fetch(): Promise<VodovodPrilepItem[]> {
        return fetchJson(this.url, vodovodPrilepResponseSchema, {
            headers: { ...BROWSER_JSON_HEADERS },
        });
    }

    async parse(
        posts: VodovodPrilepItem[],
    ): Promise<VodovodPrilepReportInsert[]> {
        const now = new Date();
        const results: VodovodPrilepReportInsert[] = [];

        for (const post of posts) {
            const day = extractIsoDay(post.date);
            if (!day) continue;

            const dayBounds = buildLocalWindow(day, 0, 0, 23, 59, 59, 999);
            if (!dayBounds) continue;

            const postTitle =
                this.cleanText(post.title.rendered) ||
                'Водоснабдување на Општина Прилеп';
            const postDate = post.date.trim();
            const postLink = post.link.trim();

            const { supplyHtml, outageHtml } = this.splitContentSections(
                post.content.rendered,
            );

            const supplySummary = this.extractSupplySummary(
                supplyHtml,
                post.excerpt?.rendered,
            );
            const streets = this.extractStreets(outageHtml);
            const isDailyBulletin =
                Boolean(supplySummary) &&
                /водоснабдувањето\s+на\s+ден/iu.test(supplySummary as string);

            if (isDailyBulletin && supplySummary) {
                const supply = this.parseSupplyMetrics(supplySummary);
                const isAbnormal =
                    ABNORMAL_SUPPLY_RE.test(supplySummary) ||
                    !/нормално/iu.test(supplySummary);

                const lifecycle = deriveLifecycleStatus(
                    now,
                    dayBounds.startsAt,
                    dayBounds.endsAt,
                );
                const status = isAbnormal
                    ? lifecycle
                    : lifecycle === 'ended'
                      ? 'ended'
                      : 'omitted';

                results.push({
                    externalId: this.buildExternalId(post.id, 'supply'),
                    source: this.source,
                    category: this.category,
                    title: this.formatSupplyTitle(isAbnormal),
                    description: this.formatSupplyDescription(supplySummary),
                    municipalityCode: PRILEP_MUNICIPALITY_CODE,
                    locationLabel: 'Прилеп',
                    status,
                    observedAt: now,
                    startsAt: dayBounds.startsAt,
                    endsAt: dayBounds.endsAt,
                    rawPayload: {
                        postId: post.id,
                        date: postDate,
                        link: postLink,
                        title: postTitle,
                        recordType: 'supply',
                        supplySummary,
                        supply,
                        street: null,
                        streets,
                    },
                });
            }

            if (streets.length > 0) {
                const supply = supplySummary
                    ? this.parseSupplyMetrics(supplySummary)
                    : null;
                const {
                    startHour,
                    startMinute,
                    endHour,
                    endMinute,
                    periodLabel,
                    reasonClause,
                } = this.parseOutageHeading(outageHtml);

                const outageBounds =
                    buildLocalWindow(
                        day,
                        startHour,
                        startMinute,
                        endHour,
                        endMinute,
                        0,
                        0,
                    ) ?? dayBounds;

                const outageStatus = deriveLifecycleStatus(
                    now,
                    outageBounds.startsAt,
                    outageBounds.endsAt,
                );

                for (const street of streets) {
                    const normalizedKey = street
                        .replace(/\.+$/, '')
                        .trim()
                        .toLowerCase();

                    const locationLabel = this.formatLocationLabel(street);

                    results.push({
                        externalId: this.buildExternalId(
                            post.id,
                            normalizedKey,
                        ),
                        source: this.source,
                        category: this.category,
                        title: this.formatOutageTitle(street),
                        description: this.formatOutageDescription(
                            street,
                            periodLabel,
                            reasonClause,
                        ),
                        municipalityCode: PRILEP_MUNICIPALITY_CODE,
                        locationLabel,
                        status: outageStatus,
                        observedAt: now,
                        startsAt: outageBounds.startsAt,
                        endsAt: outageBounds.endsAt,
                        rawPayload: {
                            postId: post.id,
                            date: postDate,
                            link: postLink,
                            title: postTitle,
                            recordType: 'outage',
                            supplySummary,
                            supply,
                            street,
                            streets,
                        },
                    });
                }

                continue;
            }

            if (!isDailyBulletin) {
                const bodyText = this.cleanText(
                    post.content.rendered || post.excerpt?.rendered || '',
                );
                const combinedText = `${postTitle} ${bodyText}`.trim();

                if (
                    !bodyText ||
                    ADMIN_IGNORE_RE.test(combinedText) ||
                    !EMERGENCY_NOTICE_RE.test(combinedText)
                ) {
                    continue;
                }

                const extractedLoc = this.extractNoticeLocation(
                    postTitle,
                    bodyText,
                );
                const locationLabel = this.formatLocationLabel(extractedLoc);
                const status = deriveLifecycleStatus(
                    now,
                    dayBounds.startsAt,
                    dayBounds.endsAt,
                );

                results.push({
                    externalId: this.buildExternalId(post.id, 'notice'),
                    source: this.source,
                    category: this.category,
                    title: this.formatNoticeTitle(extractedLoc),
                    description: this.formatNoticeDescription(bodyText),
                    municipalityCode: PRILEP_MUNICIPALITY_CODE,
                    locationLabel,
                    status,
                    observedAt: now,
                    startsAt: dayBounds.startsAt,
                    endsAt: dayBounds.endsAt,
                    rawPayload: {
                        postId: post.id,
                        date: postDate,
                        link: postLink,
                        title: postTitle,
                        recordType: 'notice',
                        supplySummary: null,
                        supply: null,
                        street: extractedLoc,
                        streets: [],
                    },
                });
            }
        }

        return results;
    }

    private buildExternalId(postId: number, key: string): string {
        return hashExternalId(postId, key);
    }

    private formatSupplyTitle(isAbnormal: boolean): string {
        return isAbnormal
            ? 'Нарушено водоснабдување: Прилеп'
            : 'Водоснабдување: Прилеп';
    }

    private formatSupplyDescription(supplySummary: string): string {
        return ensurePeriod(supplySummary);
    }

    private formatOutageTitle(street: string): string {
        return `Прекин во водоснабдувањето: ${street}`;
    }

    private formatOutageDescription(
        street: string,
        periodLabel: string,
        reasonClause: string,
    ): string {
        return `Прекин во водоснабдувањето ${reasonClause} во периодот од ${periodLabel} часот на ${street}.`;
    }

    private formatNoticeTitle(location: string | null): string {
        return `Вонредно известување: ${location ?? 'Прилеп'}`;
    }

    private formatNoticeDescription(bodyText: string): string {
        return ensurePeriod(bodyText);
    }

    private splitContentSections(html: string): {
        supplyHtml: string;
        outageHtml: string;
    } {
        const match = html.match(
            /(?:<h\d[^>]*>\s*)?Прекин\s+во\s+водоснабдувањето/iu,
        );
        if (!match || match.index === undefined) {
            return { supplyHtml: html, outageHtml: '' };
        }

        return {
            supplyHtml: html.slice(0, match.index),
            outageHtml: html.slice(match.index),
        };
    }

    private extractSupplySummary(
        supplyHtml: string,
        excerptHtml?: string,
    ): string | null {
        const cleanedSupply = this.cleanText(supplyHtml);
        const startIdx = cleanedSupply
            .toLowerCase()
            .indexOf('водоснабдувањето на ден');

        if (startIdx !== -1) {
            return cleanedSupply.slice(startIdx).trim();
        }

        if (cleanedSupply) {
            return cleanedSupply;
        }

        if (excerptHtml) {
            const cleanedExcerpt = this.cleanText(
                excerptHtml.split(/Прекин\s+во\s+водоснабдувањето/iu)[0] ?? '',
            );
            if (cleanedExcerpt) return cleanedExcerpt;
        }

        return null;
    }

    private parseSupplyMetrics(text: string): VodovodPrilepSupply {
        const toNumber = (match: RegExpMatchArray | null): number | null => {
            if (!match?.[1]) return null;
            const parsed = Number(match[1].replace(',', '.'));
            return Number.isFinite(parsed) ? parsed : null;
        };

        return {
            totalLs: toNumber(
                text.match(
                    /количина\s+на\s+вода(?:\s+е)?\s*(\d+(?:[.,]\d+)?)\s*л\/с/iu,
                ),
            ),
            studenchicaLs: toNumber(
                text.match(/(\d+(?:[.,]\d+)?)\s*л\/с\s*од\s*Студенчица/iu),
            ),
            wellsLs: toNumber(
                text.match(/(\d+(?:[.,]\d+)?)\s*л\/с\s*од\s*бунари/iu),
            ),
            springsLs: toNumber(
                text.match(
                    /(\d+(?:[.,]\d+)?)\s*л\/с\s*(?:од\s*)?сопствени\s*извори/iu,
                ),
            ),
        };
    }

    private parseOutageHeading(outageHtml: string): {
        startHour: number;
        startMinute: number;
        endHour: number;
        endMinute: number;
        periodLabel: string;
        reasonClause: string;
    } {
        const headingPart =
            outageHtml.split(/Општина\s+Прилеп\s*:/iu)[0] ?? outageHtml;
        const cleanedHeading = this.cleanText(headingPart);

        const timeMatch = cleanedHeading.match(
            /во\s+периодот\s+од\s*(\d{1,2})(?::(\d{2}))?\s*до\s*(\d{1,2})(?::(\d{2}))?\s*часот/iu,
        );

        const startHour = timeMatch?.[1] ? Number(timeMatch[1]) : 8;
        const startMinute = timeMatch?.[2] ? Number(timeMatch[2]) : 0;
        const endHour = timeMatch?.[3] ? Number(timeMatch[3]) : 14;
        const endMinute = timeMatch?.[4] ? Number(timeMatch[4]) : 0;

        const pad = (n: number) => String(n).padStart(2, '0');
        const periodLabel = `${pad(startHour)}:${pad(startMinute)} до ${pad(endHour)}:${pad(endMinute)}`;

        const reasonMatch = cleanedHeading.match(
            /Прекин\s+во\s+водоснабдувањето\s+(заради\s+.+?)\s+во\s+периодот/iu,
        );
        const reasonClause =
            reasonMatch?.[1]?.trim() ??
            'заради санација на дефекти и приклучоци';

        return {
            startHour,
            startMinute,
            endHour,
            endMinute,
            periodLabel,
            reasonClause,
        };
    }

    private extractStreets(outageHtml: string): string[] {
        if (!outageHtml) return [];

        const afterColon = outageHtml.split(/Општина\s+Прилеп\s*:/iu)[1];
        if (!afterColon) return [];

        const rawSegments = afterColon.split(
            /<\/h\d>|<\/li>|<\/p>|<br\s*\/?>|\n/gi,
        );

        const seen = new Set<string>();
        const streets: string[] = [];

        for (const segment of rawSegments) {
            const cleaned = this.cleanText(segment)
                .replace(/^[-–—•*]+\s*/u, '')
                .replace(/\.+$/, '')
                .trim();

            if (!cleaned) continue;

            const dedupeKey = cleaned.toLowerCase();
            if (seen.has(dedupeKey)) continue;

            seen.add(dedupeKey);
            streets.push(cleaned);
        }

        return streets;
    }

    private extractNoticeLocation(title: string, body: string): string | null {
        const match =
            title.match(INLINE_LOCATION_RE) ?? body.match(INLINE_LOCATION_RE);
        if (!match?.[1]) return null;

        return match[1]
            .replace(/["„“”]/g, '')
            .replace(/\.(?=\p{Lu})/gu, '. ')
            .replace(/\s+/g, ' ')
            .replace(/[.,]+$/, '')
            .trim();
    }

    private formatLocationLabel(location: string | null): string {
        if (!location) return 'Прилеп';
        if (/прилеп$/iu.test(location)) return location;
        return `${location}, Прилеп`;
    }

    private cleanText(raw: string): string {
        return decodeHtmlText(raw)
            .replace(/\[(?:\.\.\.|…)\]/g, '')
            .replace(/(?<!\d),(?!\s)/g, ', ')
            .replace(/\.(?=\p{Lu})/gu, '. ')
            .replace(/(\d)\s*л\/с/giu, '$1л/с')
            .replace(/\s+/g, ' ')
            .trim();
    }
}
