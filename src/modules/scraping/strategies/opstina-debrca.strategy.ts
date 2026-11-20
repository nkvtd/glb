import type { OpstinaDebrcaReportInsert } from '../../../core/types/opstina-debrca.js';
import {
    type OpstinaDebrcaItem,
    opstinaDebrcaResponseSchema,
} from '../../../core/validation/opstina-debrca.js';
import type { ScrapingStrategy } from '../strategy.interface.js';
import { BROWSER_JSON_HEADERS, fetchJson } from './util/fetch.js';
import { hashExternalId } from './util/hash.js';
import {
    decodeHtmlText,
    formatSummarySentences,
    splitSentences,
} from './util/text.js';
import {
    buildLocalWindow,
    deriveLifecycleStatus,
    formatIsoDay,
    parseWordPressPublishDate,
} from './util/time.js';

const DEBRCA_MUNICIPALITY_CODE = 'MK0030400';

const NOISE_RE =
    /кант|240л|одпад|отпад|пожар|јавен\s+повик|управен\s+одбор|трактор|возило|канал/iu;

const WATER_RE =
    /водовод|водоснабд|вода\s+за\s+пиење|пиење\s+на\s+водата|квалитет(?:от)?\s+на\s+водата|заматеност|матност/iu;

const WATER_SAFE_RE =
    /здравствено\s+исправна|слободно\s+да\s+ја\s+користат\s+водата/iu;

const CLOSED_RE = /нормализиран|завршен|пуштен(?:о)?|безбедна/iu;

const OPEN_ENDED_BAN_RE =
    /до\s+стабилизирање|не\s+се\s+(?:користи|препорачува|употребува)\s+(?:водата\s+)?за\s+пиење|да\s+не\s+(?:се\s+користи|ја\s+(?:користат|употребуваат))\s+(?:водата\s+)?за\s+пиење|не\s+е\s+за\s+пиење/iu;

const OPEN_ENDED_BAN_TTL_MS = 14 * 24 * 60 * 60 * 1000;

const UNDATED_WATER_TTL_MS = 3 * 24 * 60 * 60 * 1000;

const ATTACHMENT_TAIL_RE = /\s*Прилог\s+детални\s+извештаи.*$/isu;

const SIGNATURE_TAIL_RE = /\s*Со\s+почит,?\s*(?:ЈКП|ЈП)?\s*Деб(?:а)?рца.*$/isu;

const LOCATION_ANCHOR_RE = /(?:населени\s+места|за\s+селата|во\s+селата)\s+/iu;

const PREFIXED_VILLAGE_RE =
    /(?:с\.|село|селото|селата)\s*(\p{Lu}\p{Ll}+(?:\s+\p{Lu}\p{Ll}+)*)/gu;

const MULTI_DAY_PERIOD_RE =
    /(?:во\s+период(?:от)?\s+)?од\s+(\d{1,2})\.(\d{1,2})\.(\d{4})(?:\s*г(?:од(?:ина|\.)?)?)?\s*до\s+(\d{1,2})\.(\d{1,2})\.(\d{4})(?:\s*г(?:од(?:ина|\.)?)?)?/iu;

const SINGLE_DAY_RE = /(\d{1,2})\.(\d{1,2})\.(\d{4})/u;

const DAY_TIME_RE =
    /од\s+(\d{1,2})(?::(\d{2}))?\s*(?:часот\s+)?до\s+(\d{1,2})(?::(\d{2}))?/iu;

type EventWindow = {
    startsAt: Date;
    endsAt: Date | null;
    status: OpstinaDebrcaReportInsert['status'];
};

export class OpstinaDebrcaStrategy
    implements ScrapingStrategy<OpstinaDebrcaItem[], OpstinaDebrcaReportInsert>
{
    readonly source = 'opstina-debrca';
    readonly url: string;
    readonly category = 'water' as const;
    readonly target = 'reports';
    readonly schedule: string;

    constructor(url: string, schedule: string) {
        this.url = url;
        this.schedule = schedule;
    }

    async fetch(): Promise<OpstinaDebrcaItem[]> {
        return fetchJson(this.url, opstinaDebrcaResponseSchema, {
            headers: { ...BROWSER_JSON_HEADERS },
        });
    }

    async parse(
        posts: OpstinaDebrcaItem[],
    ): Promise<OpstinaDebrcaReportInsert[]> {
        const now = new Date();
        const results: OpstinaDebrcaReportInsert[] = [];

        for (const post of posts) {
            const publishDate = parseWordPressPublishDate(post);
            if (!publishDate) continue;

            const title = this.cleanText(post.title.rendered);
            const body = this.cleanText(post.content.rendered);
            if (!body && !title) continue;

            const combined = `${title} ${body}`;
            if (NOISE_RE.test(combined) || !WATER_RE.test(combined)) continue;

            const villageLabel = this.formatVillageList(
                this.extractLocation(title, body),
            );
            const locationLabel = villageLabel
                ? `${villageLabel}, Дебрца`
                : 'Дебрца';

            results.push({
                externalId: hashExternalId(post.id),
                source: this.source,
                category: this.category,
                title: this.formatTitle(title, body, villageLabel ?? 'Дебрца'),
                description: this.formatDescription(title, body),
                municipalityCode: DEBRCA_MUNICIPALITY_CODE,
                locationLabel,
                ...this.parseEventWindow(title, body, publishDate, now),
                observedAt: now,
                rawPayload: {
                    postId: post.id,
                    date: post.date.trim(),
                    dateGmt: post.date_gmt.trim(),
                    link: post.link.trim(),
                    title,
                },
            });
        }

        return results;
    }

    private parseEventWindow(
        title: string,
        body: string,
        publishDate: Date,
        now: Date,
    ): EventWindow {
        const combined = `${title} ${body}`;
        const isClosed = CLOSED_RE.test(combined);
        const ageMs = now.getTime() - publishDate.getTime();

        const window =
            this.parseMultiDayPeriod(body) ?? this.parseSingleDayWindow(body);
        if (window) {
            return {
                startsAt: window.startsAt,
                endsAt: window.endsAt,
                status: deriveLifecycleStatus(
                    now,
                    window.startsAt,
                    window.endsAt,
                    { closed: isClosed },
                ),
            };
        }

        if (WATER_SAFE_RE.test(combined)) {
            return { startsAt: publishDate, endsAt: null, status: 'omitted' };
        }

        if (OPEN_ENDED_BAN_RE.test(combined)) {
            return {
                startsAt: publishDate,
                endsAt: null,
                status:
                    isClosed || ageMs > OPEN_ENDED_BAN_TTL_MS
                        ? 'ended'
                        : 'ongoing',
            };
        }

        return {
            startsAt: publishDate,
            endsAt: null,
            status:
                isClosed || ageMs > UNDATED_WATER_TTL_MS ? 'ended' : 'ongoing',
        };
    }

    private parseMultiDayPeriod(
        body: string,
    ): { startsAt: Date; endsAt: Date } | null {
        const match = body.match(MULTI_DAY_PERIOD_RE);
        if (!match) return null;

        const start = buildLocalWindow(
            formatIsoDay(match[3] ?? '', match[2] ?? '', match[1] ?? ''),
            0,
            0,
            0,
            0,
        );
        const end = buildLocalWindow(
            formatIsoDay(match[6] ?? '', match[5] ?? '', match[4] ?? ''),
            23,
            59,
            23,
            59,
            59,
            999,
        );
        if (!start || !end || end.endsAt <= start.startsAt) return null;
        return { startsAt: start.startsAt, endsAt: end.endsAt };
    }

    private parseSingleDayWindow(
        body: string,
    ): { startsAt: Date; endsAt: Date } | null {
        const dayMatch = body.match(SINGLE_DAY_RE);
        if (!dayMatch) return null;

        const day = formatIsoDay(
            dayMatch[3] ?? '',
            dayMatch[2] ?? '',
            dayMatch[1] ?? '',
        );

        const timeMatch = body.match(DAY_TIME_RE);
        if (timeMatch?.[1] && timeMatch[3]) {
            return buildLocalWindow(
                day,
                Number(timeMatch[1]),
                timeMatch[2] === undefined ? 0 : Number(timeMatch[2]),
                Number(timeMatch[3]),
                timeMatch[4] === undefined ? 0 : Number(timeMatch[4]),
            );
        }

        return buildLocalWindow(day, 0, 0, 23, 59, 59, 999);
    }

    private extractLocation(title: string, body: string): string[] {
        return (
            this.extractAnchoredVillages(title) ??
            this.extractAnchoredVillages(body) ??
            this.extractPrefixedVillages(title) ??
            this.extractPrefixedVillages(body) ??
            []
        );
    }

    private extractAnchoredVillages(text: string): string[] | null {
        const anchor = text.match(LOCATION_ANCHOR_RE);
        if (!anchor || anchor.index === undefined) return null;

        const words = text.slice(anchor.index + anchor[0].length).split(/\s+/);
        const items: string[] = [];
        let current: string[] = [];

        for (let i = 0; i < words.length; i++) {
            const word = words[i] ?? '';
            const trimmed = word.replace(/[.,;:]+$/u, '');
            if (trimmed === '') break;

            if (trimmed === 'и' || trimmed === 'И') {
                const next = (words[i + 1] ?? '').replace(/[.,;:]+$/u, '');
                if (/^\p{Lu}\p{L}+/u.test(next)) {
                    current.push('и');
                    continue;
                }
                break;
            }

            if (!/^\p{Lu}\p{L}+/u.test(trimmed)) break;

            current.push(trimmed);
            if (trimmed !== word) {
                items.push(current.join(' '));
                current = [];
            }
        }

        if (current.length > 0) items.push(current.join(' '));
        return items.length > 0 ? items : null;
    }

    private extractPrefixedVillages(text: string): string[] | null {
        const items: string[] = [];
        for (const match of text.matchAll(PREFIXED_VILLAGE_RE)) {
            if (match[1]) items.push(match[1]);
        }
        return items.length > 0 ? items : null;
    }

    private formatVillageList(villages: string[]): string | null {
        if (villages.length === 0) return null;

        const last = villages.at(-1);
        if (last === undefined) return null;

        const head = villages.slice(0, -1).join(', ');
        const joiner = /\sи\s/u.test(last) ? ', ' : ' и ';
        return `${head ? `${head}${joiner}` : ''}${last}`;
    }

    private formatTitle(title: string, body: string, location: string): string {
        const combined = `${title} ${body}`;

        if (WATER_SAFE_RE.test(combined)) {
            return `Водата е безбедна за пиење: ${location}`;
        }

        if (
            OPEN_ENDED_BAN_RE.test(combined) ||
            /заматеност|матност/iu.test(combined)
        ) {
            return `Забрана за вода за пиење: ${location}`;
        }

        if (/дефект|прекин/iu.test(combined)) {
            return `Прекин во водоснабдувањето: ${location}`;
        }

        return `Водоснабдување: ${location}`;
    }

    private formatDescription(title: string, body: string): string {
        const prose =
            body
                .replace(ATTACHMENT_TAIL_RE, '')
                .replace(SIGNATURE_TAIL_RE, '')
                .trim() || title.trim();

        return formatSummarySentences(splitSentences(prose));
    }

    private cleanText(raw: string): string {
        return decodeHtmlText(
            raw
                .replace(/<noscript>[\s\S]*?<\/noscript>/gi, '')
                .replace(/\u00a0/g, ' '),
        );
    }
}
