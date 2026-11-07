import { createHash } from 'node:crypto';
import type { VodovodKumanovoReportInsert } from '../../../core/types/vodovod-kumanovo.js';
import {
    type VodovodKumanovoItem,
    vodovodKumanovoResponseSchema,
} from '../../../core/validation/vodovod-kumanovo.js';
import type { ScrapingStrategy } from '../strategy.interface.js';

const KUMANOVO_MUNICIPALITY_CODE = 'MK0070300';

const SKOPJE_OFFSET_FORMATTER = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Skopje',
    timeZoneName: 'longOffset',
});

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
        const response = await fetch(this.url, {
            headers: {
                Accept: 'application/json',
                'User-Agent':
                    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            },
            signal: AbortSignal.timeout(15_000),
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(
                `Fetch failed with status code ${response.status}: ${errorText}`,
            );
        }

        const data = await response.json();

        return vodovodKumanovoResponseSchema.parse(data);
    }

    async parse(
        posts: VodovodKumanovoItem[],
    ): Promise<VodovodKumanovoReportInsert[]> {
        const now = new Date();
        const results: VodovodKumanovoReportInsert[] = [];

        for (const post of posts) {
            const bounds = this.parseSkopjeDayBounds(post.date);
            if (!bounds) continue;

            const { startsAt, endsAt } = bounds;
            const rawItems = this.extractItems(post.content.rendered);
            if (rawItems.length === 0) continue;

            const status =
                now < startsAt
                    ? 'scheduled'
                    : now <= endsAt
                      ? 'ongoing'
                      : 'ended';

            const postTitle = this.cleanText(post.title.rendered);
            const postDate = post.date.trim();
            const postLink = post.link.trim();

            for (const rawItem of rawItems) {
                const normalizedKey = rawItem
                    .replace(/\.+$/, '')
                    .trim()
                    .toLowerCase();

                const externalId = createHash('sha256')
                    .update(`${post.id}|${normalizedKey}`)
                    .digest('hex')
                    .slice(0, 32);

                const { location, detail } =
                    this.splitLocationAndDetail(rawItem);

                const locationLabel = this.formatLocationLabel(location);
                const isDefect =
                    DEFECT_KEYWORDS_RE.test(rawItem) || detail === null;
                const titlePrefix = isDefect ? 'Дефект' : 'Интервенција';
                const title = `${titlePrefix}: ${location ?? 'Куманово'}`;
                const description = this.formatDescription(
                    location,
                    detail,
                    rawItem,
                );

                results.push({
                    externalId,
                    source: this.source,
                    category: this.category,
                    title,
                    description,
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
            const cleaned = this.cleanText(candidate)
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
            const cleanDetail = detail.replace(/\.+$/, '').trim();
            return `${location} – ${cleanDetail}.`;
        }

        const stripped = rawItem.replace(/\.+$/, '').trim();
        const capitalized =
            stripped.charAt(0).toUpperCase() + stripped.slice(1);

        return `${capitalized}.`;
    }

    private parseSkopjeDayBounds(
        rawDate: string,
    ): { startsAt: Date; endsAt: Date } | null {
        const match = rawDate.trim().match(/^(\d{4}-\d{2}-\d{2})/);
        if (!match?.[1]) return null;

        const day = match[1];
        const startProbe = new Date(`${day}T00:00:00Z`);
        const endProbe = new Date(`${day}T21:00:00Z`);

        if (
            Number.isNaN(startProbe.getTime()) ||
            Number.isNaN(endProbe.getTime())
        ) {
            return null;
        }

        const startOffset = this.getSkopjeOffset(startProbe);
        const endOffset = this.getSkopjeOffset(endProbe);

        const startsAt = new Date(`${day}T00:00:00.000${startOffset}`);
        const endsAt = new Date(`${day}T23:59:59.999${endOffset}`);

        if (
            Number.isNaN(startsAt.getTime()) ||
            Number.isNaN(endsAt.getTime())
        ) {
            return null;
        }

        return { startsAt, endsAt };
    }

    private getSkopjeOffset(utcProbe: Date): string {
        const tzPart =
            SKOPJE_OFFSET_FORMATTER.formatToParts(utcProbe).find(
                (p) => p.type === 'timeZoneName',
            )?.value ?? 'GMT+01:00';

        const offset = tzPart.replace('GMT', '');
        return /^[+-]\d{2}:\d{2}$/.test(offset) ? offset : '+01:00';
    }

    private cleanText(raw: string): string {
        return raw
            .replace(/<[^>]+>/g, ' ')
            .replace(/&#8211;|&ndash;/gi, '–')
            .replace(/&#8212;|&mdash;/gi, '—')
            .replace(/&nbsp;|&#160;/gi, ' ')
            .replace(/&amp;|&#038;/gi, '&')
            .replace(/&quot;|&#8220;|&#8221;|&ldquo;|&rdquo;/gi, '"')
            .replace(/&#8216;|&#8217;|&lsquo;|&rsquo;/gi, "'")
            .replace(/&hellip;|&#8230;/gi, '...')
            .replace(/&lt;|&#60;/gi, '<')
            .replace(/&gt;|&#62;/gi, '>')
            .replace(/\(\s+/g, '(')
            .replace(/\s+\)/g, ')')
            .replace(/\s+,/g, ',')
            .replace(/,(?!\s|\d)/g, ', ')
            .replace(/\s+/g, ' ')
            .trim();
    }
}
