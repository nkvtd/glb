import type { VodovodKumanovoReportInsert } from '../../../core/types/vodovod-kumanovo.js';
import {
    type VodovodKumanovoItem,
    vodovodKumanovoResponseSchema,
} from '../../../core/validation/vodovod-kumanovo.js';
import type { ScrapingStrategy } from '../strategy.interface.js';
import { BROWSER_JSON_HEADERS, fetchJson } from './util/fetch.js';
import { hashExternalId } from './util/hash.js';
import { capitalizeFirst, decodeHtmlText, ensurePeriod } from './util/text.js';
import {
    buildLocalWindow,
    deriveLifecycleStatus,
    extractIsoDay,
} from './util/time.js';

const KUMANOVO_MUNICIPALITY_CODE = 'MK0070300';

const ACTION_START_RE =
    /^(?:дефект|чистење|испитување|проверка|теренска|замена|сервисирање|корекција|кодекција|затрпување|периодична|прекин|монтажа|изместување|приклучување|нивелирање|хиперхлорирање|поправка|водоснабдувањето|на\s+ден)(?=$|\s|[,.–—:;()])/iu;

const LOCATION_PREFIX_RE =
    /^(?:ул\.|улица|бул\.|булевар|нас\.|населба|м\.в\.|с\.|село|плоштад)\s+/iu;

const INLINE_LOCATION_RE =
    /(?:^|\s)(?:на|во)\s+(?:атар\s+на\s+)?((?:ул\.|улица|бул\.|булевар|нас\.|населба|м\.в\.|с\.|село|плоштад)\s+.+?)(?=\s+(?:по|за|до|поради|како|со|од|во|и\s+тоа)(?=\s|$)|[,–—]|\.$|$)/iu;

const DEFECT_KEYWORDS_RE =
    /дефект|истекување|прекин|намален\s+притисок|пукнат/iu;

export class VodovodKumanovoStrategy
    implements
        ScrapingStrategy<VodovodKumanovoItem[], VodovodKumanovoReportInsert>
{
    readonly source = 'vodovod-kumanovo';
    readonly url: string;
    readonly category = 'water' as const;
    readonly target = 'reports';
    readonly schedule: string;

    constructor(url: string, schedule: string) {
        this.url = url;
        this.schedule = schedule;
    }

    async fetch(): Promise<VodovodKumanovoItem[]> {
        return fetchJson(this.url, vodovodKumanovoResponseSchema, {
            headers: { ...BROWSER_JSON_HEADERS },
        });
    }

    async parse(
        posts: VodovodKumanovoItem[],
    ): Promise<VodovodKumanovoReportInsert[]> {
        const now = new Date();
        const results: VodovodKumanovoReportInsert[] = [];

        for (const post of posts) {
            const day = extractIsoDay(post.date);
            if (!day) continue;

            const bounds = buildLocalWindow(day, 0, 0, 23, 59, 59, 999);
            if (!bounds) continue;

            const { startsAt, endsAt } = bounds;
            const rawItems = this.extractItems(post.content.rendered);
            if (rawItems.length === 0) continue;

            const status = deriveLifecycleStatus(now, startsAt, endsAt);

            const postTitle = decodeHtmlText(post.title.rendered);
            const postDate = post.date.trim();
            const postLink = post.link.trim();

            for (const rawItem of rawItems) {
                const normalizedKey = rawItem
                    .replace(/\.+$/, '')
                    .trim()
                    .toLowerCase();

                const { location, detail } =
                    this.splitLocationAndDetail(rawItem);

                const locationLabel = this.formatLocationLabel(location);
                const isDefect =
                    DEFECT_KEYWORDS_RE.test(rawItem) || detail === null;

                results.push({
                    externalId: this.buildExternalId(post.id, normalizedKey),
                    source: this.source,
                    category: this.category,
                    title: this.formatTitle(isDefect, location),
                    description: this.formatDescription(
                        location,
                        detail,
                        rawItem,
                    ),
                    municipalityCode: KUMANOVO_MUNICIPALITY_CODE,
                    locationLabel,
                    status,
                    observedAt: now,
                    startsAt,
                    endsAt,
                    rawPayload: {
                        postId: post.id,
                        date: postDate,
                        link: postLink,
                        title: postTitle,
                        item: rawItem,
                        items: rawItems,
                    },
                });
            }
        }

        return results;
    }

    private buildExternalId(postId: number, normalizedKey: string): string {
        return hashExternalId(postId, normalizedKey);
    }

    private formatTitle(isDefect: boolean, location: string | null): string {
        return `${isDefect ? 'Дефект' : 'Интервенција'}: ${location ?? 'Куманово'}`;
    }

    private extractItems(html: string): string[] {
        const liMatches = Array.from(
            html.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi),
            (m) => m[1] ?? '',
        );

        const candidates =
            liMatches.length > 0
                ? liMatches
                : Array.from(
                      html.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi),
                      (m) => m[1] ?? '',
                  );

        const seen = new Set<string>();
        const items: string[] = [];

        for (const candidate of candidates) {
            const cleaned = decodeHtmlText(candidate)
                .replace(/^[-–—•*]+\s*/u, '')
                .trim();

            if (!cleaned) continue;

            const dedupeKey = cleaned.replace(/\.+$/, '').trim().toLowerCase();
            if (!dedupeKey || seen.has(dedupeKey)) continue;

            seen.add(dedupeKey);
            items.push(cleaned);
        }

        return items;
    }

    private splitLocationAndDetail(text: string): {
        location: string | null;
        detail: string | null;
    } {
        let depth = 0;
        let lastDashIndex = -1;

        for (let i = 0; i < text.length; i++) {
            const ch = text[i];
            if (ch === '(') {
                depth++;
            } else if (ch === ')' && depth > 0) {
                depth--;
            } else if (depth === 0) {
                const isDash = ch === '–' || ch === '—';
                const isSpacedHyphen =
                    ch === '-' && (text[i - 1] === ' ' || text[i + 1] === ' ');
                if (isDash || isSpacedHyphen) {
                    lastDashIndex = i;
                }
            }
        }

        if (lastDashIndex !== -1) {
            const left = text
                .slice(0, lastDashIndex)
                .replace(/[-–—.,\s]+$/u, '')
                .trim();
            const right = text
                .slice(lastDashIndex + 1)
                .replace(/^[-–—\s]+/u, '')
                .trim();

            if (left && right && !ACTION_START_RE.test(left)) {
                return { location: left, detail: right };
            }
        }

        if (LOCATION_PREFIX_RE.test(text) && !ACTION_START_RE.test(text)) {
            return {
                location: text.replace(/\.+$/, '').trim(),
                detail: null,
            };
        }

        const inlineMatch = text.match(INLINE_LOCATION_RE);
        if (inlineMatch?.[1]) {
            return {
                location: inlineMatch[1].replace(/[.,]+$/, '').trim(),
                detail: text,
            };
        }

        return { location: null, detail: text };
    }

    private formatLocationLabel(location: string | null): string {
        if (!location) return 'Куманово';
        if (/куманово$/iu.test(location)) return location;
        return `${location}, Куманово`;
    }

    private formatDescription(
        location: string | null,
        detail: string | null,
        rawItem: string,
    ): string {
        if (location && detail && detail !== rawItem) {
            return `${location} – ${ensurePeriod(detail)}`;
        }

        return capitalizeFirst(ensurePeriod(rawItem));
    }
}
