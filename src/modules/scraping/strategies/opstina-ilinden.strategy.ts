import type {
    OpstinaIlindenCategory,
    OpstinaIlindenReportInsert,
} from '../../../core/types/opstina-ilinden.js';
import {
    type OpstinaIlindenItem,
    opstinaIlindenResponseSchema,
} from '../../../core/validation/opstina-ilinden.js';
import type { ScrapingStrategy } from '../strategy.interface.js';
import { BROWSER_JSON_HEADERS, fetchJson } from './util/fetch.js';
import { hashExternalId } from './util/hash.js';
import { decodeHtmlText, ensurePeriod } from './util/text.js';
import {
    buildLocalWindow,
    deriveLifecycleStatus,
    extractIsoDay,
    parseLocalMidnight,
} from './util/time.js';

const ILINDEN_MUNICIPALITY_CODE = 'MK0080700';

const NOISE_RE =
    /прскање\s+против\s+комарци|буџет|ГИС|ОБЈАВА|ЈАВЕН\s+ПОВИК|отуѓување|наддавање|субвенции|субвенционирање|поддршка|повик\s+за|отворен\s+ден|крводарителна|спортисти|меморандум|идеи,\s*предлози/iu;

const WATER_TITLE_RE = /ИЗВЕСТУВАЊЕ.*(?:ПРЕКИН|ВОДОСНАБДУВАЊЕ)/iu;

const ROAD_TITLE_RE = /асфалт|улица|сообраќај|реконструкција|пат/iu;

const CLOSED_RE = /нормализиран|завршен|пуштен/iu;

const UNDATED_WATER_TTL_MS = 3 * 24 * 60 * 60 * 1000;
const UNDATED_ROAD_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const PREFIXED_NAME_RE = /н\.м\.\s*(\p{Lu}\p{Ll}+(?:\s+\p{Lu}\p{Ll}+)*)/gu;

const LOCATION_ANCHOR_RE = /населени(?:те)?\s+места?\s+/iu;

const SENTENCE_SPLIT_RE =
    /(?<=[.!?])(?<!(?<!\p{L})(?:ул|с|бр|г|год|св|т\.н)[.!?])\s+/iu;

const MULTI_DAY_WINDOW_RE =
    /почнувајќи\s+од\s+(?:утре\s+)?(\d{1,2})\.(\d{1,2})\.(\d{4})(?:\s*година)?[\s\S]*?во\s+наредните\s+денови\s+([^.;]+)/iu;

const SINGLE_DAY_RE = /на\s+ден\s+(\d{1,2})\.(\d{1,2})\.(\d{4})/iu;

const PERIOD_TIME_RE =
    /(?:во\s+периодот\s+)?од\s+(\d{1,2}):(\d{2})\s*до\s+(\d{1,2}):(\d{2})/iu;

const WEEKDAYS = new Set([
    'понеделник',
    'вторник',
    'среда',
    'четврток',
    'петок',
    'сабота',
    'недела',
]);

type EventWindow = {
    startsAt: Date;
    endsAt: Date | null;
    status: OpstinaIlindenReportInsert['status'];
};

const pad2 = (value: number) => String(value).padStart(2, '0');

function formatIsoDay(year: string, month: string, day: string): string {
    return `${year}-${pad2(Number(month))}-${pad2(Number(day))}`;
}

export class OpstinaIlindenStrategy
    implements
        ScrapingStrategy<OpstinaIlindenItem[], OpstinaIlindenReportInsert>
{
    readonly source: string;
    readonly url: string;
    readonly category: OpstinaIlindenCategory;
    readonly target = 'reports';
    readonly schedule: string;

    constructor(
        url: string,
        schedule: string,
        category: OpstinaIlindenCategory,
    ) {
        this.source = `opstina-ilinden-${category}`;
        this.url = url;
        this.schedule = schedule;
        this.category = category;
    }

    async fetch(): Promise<OpstinaIlindenItem[]> {
        return fetchJson(this.url, opstinaIlindenResponseSchema, {
            headers: { ...BROWSER_JSON_HEADERS },
        });
    }

    async parse(
        posts: OpstinaIlindenItem[],
    ): Promise<OpstinaIlindenReportInsert[]> {
        const now = new Date();
        const results: OpstinaIlindenReportInsert[] = [];

        for (const post of posts) {
            const publishDate = this.parsePublishDate(post);
            if (!publishDate) continue;

            const title = this.cleanText(post.title.rendered);
            const body = this.cleanText(post.content.rendered);
            if (!body && !title) continue;

            if (this.classifyPost(title) !== this.category) continue;

            const location = this.extractLocation(title, body) ?? 'Илинден';
            const locationLabel = this.formatLocationLabel(location);

            results.push({
                externalId: hashExternalId(post.id),
                source: this.source,
                category: this.category,
                title: this.formatTitle(location),
                description: this.formatDescription(title, body),
                municipalityCode: ILINDEN_MUNICIPALITY_CODE,
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

    private parsePublishDate(post: OpstinaIlindenItem): Date | null {
        const gmtDate = new Date(`${post.date_gmt.trim()}Z`);
        if (!Number.isNaN(gmtDate.getTime())) return gmtDate;

        const day = extractIsoDay(post.date);
        if (!day) return null;

        const localDate = parseLocalMidnight(day);
        return Number.isNaN(localDate.getTime()) ? null : localDate;
    }

    private classifyPost(title: string): OpstinaIlindenCategory | null {
        if (NOISE_RE.test(title)) return null;
        if (WATER_TITLE_RE.test(title)) return 'water';
        if (ROAD_TITLE_RE.test(title)) return 'road';
        return null;
    }

    private parseEventWindow(
        title: string,
        body: string,
        publishDate: Date,
        now: Date,
    ): EventWindow {
        const isClosed = CLOSED_RE.test(`${title} ${body}`);

        const window =
            this.parseMultiDayWindow(body) ?? this.parseSingleDayWindow(body);
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

        const ttlMs =
            this.category === 'road'
                ? UNDATED_ROAD_TTL_MS
                : UNDATED_WATER_TTL_MS;
        const ageMs = now.getTime() - publishDate.getTime();

        return {
            startsAt: publishDate,
            endsAt: null,
            status: isClosed || ageMs > ttlMs ? 'ended' : 'ongoing',
        };
    }

    private parseMultiDayWindow(
        body: string,
    ): { startsAt: Date; endsAt: Date } | null {
        const match = body.match(MULTI_DAY_WINDOW_RE);
        if (!match) return null;

        const days = (match[4] ?? '')
            .split(/[^\p{L}]+/u)
            .filter((word) => WEEKDAYS.has(word.toLowerCase())).length;
        if (days === 0) return null;

        const day = formatIsoDay(
            match[3] ?? '',
            match[2] ?? '',
            match[1] ?? '',
        );
        const start = buildLocalWindow(day, 0, 0, 0, 0);
        if (!start) return null;

        const endDay = new Date(`${day}T00:00:00Z`);
        endDay.setUTCDate(endDay.getUTCDate() + days);
        const end = buildLocalWindow(
            endDay.toISOString().slice(0, 10),
            0,
            0,
            23,
            59,
            59,
            999,
        );
        if (!end) return null;

        return { startsAt: start.startsAt, endsAt: end.endsAt };
    }

    private parseSingleDayWindow(
        body: string,
    ): { startsAt: Date; endsAt: Date } | null {
        const match = body.match(SINGLE_DAY_RE);
        if (!match) return null;

        const day = formatIsoDay(
            match[3] ?? '',
            match[2] ?? '',
            match[1] ?? '',
        );
        const timeMatch = body.match(PERIOD_TIME_RE);

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

    private extractLocation(title: string, body: string): string | null {
        const names =
            this.extractPrefixedNames(body) ??
            this.extractPrefixedNames(title) ??
            this.extractAnchoredList(body) ??
            this.extractAnchoredList(title);

        return names ? this.formatLocationList(names) : null;
    }

    private extractPrefixedNames(text: string): string[] | null {
        const names = [...text.matchAll(PREFIXED_NAME_RE)]
            .map((match) => match[1]?.trim())
            .filter((name): name is string => Boolean(name));

        return names.length > 0 ? [...new Set(names)] : null;
    }

    private extractAnchoredList(text: string): string[] | null {
        const anchor = text.match(LOCATION_ANCHOR_RE);
        if (!anchor || anchor.index === undefined) return null;

        const names: string[] = [];
        for (const raw of text
            .slice(anchor.index + anchor[0].length)
            .split(/\s+/)) {
            const word = raw.replace(/[.,;:]+$/u, '');
            if (word === '') break;
            if (word === 'и' || word === 'И') continue;
            if (!/^\p{Lu}\p{L}+/u.test(word)) break;
            names.push(word);
        }

        return names.length > 0 ? names : null;
    }

    private formatLocationList(names: string[]): string | null {
        const [first] = names;
        if (first === undefined) return null;
        if (names.length === 1) return first;

        const last = names[names.length - 1] ?? first;
        return `${names.slice(0, -1).join(', ')} и ${last}`;
    }

    private formatLocationLabel(location: string): string {
        return /(?:^|,\s*)Илинден$/iu.test(location)
            ? location
            : `${location}, Илинден`;
    }

    private formatTitle(location: string): string {
        return this.category === 'water'
            ? `Прекин во водоснабдувањето: ${location}`
            : `Реконструкција на улица: ${location}`;
    }

    private formatDescription(title: string, body: string): string {
        const prose = body.trim() || title.trim();

        const sentences = prose
            .split(SENTENCE_SPLIT_RE)
            .map((sentence) => sentence.trim())
            .filter(Boolean);

        const [first = '', second] = sentences;
        const selected =
            second !== undefined &&
            `${first} ${second}`.length > 280 &&
            first.length >= 40
                ? [first]
                : sentences.slice(0, 2);

        return ensurePeriod(selected.join(' '));
    }

    private cleanText(raw: string): string {
        return decodeHtmlText(
            raw.replace(/<!--more-->/gi, '').replace(/\u00a0/g, ' '),
        );
    }
}
