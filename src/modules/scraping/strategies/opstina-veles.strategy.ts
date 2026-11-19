import type { OpstinaVelesReportInsert } from '../../../core/types/opstina-veles.js';
import {
    type OpstinaVelesItem,
    opstinaVelesResponseSchema,
} from '../../../core/validation/opstina-veles.js';
import type { ScrapingStrategy } from '../strategy.interface.js';
import { BROWSER_JSON_HEADERS, fetchJson } from './util/fetch.js';
import { hashExternalId } from './util/hash.js';
import {
    capitalizeFirst,
    decodeHtmlText,
    ensurePeriod,
    toTitleCase,
} from './util/text.js';
import {
    buildLocalWindow,
    deriveLifecycleStatus,
    extractIsoDay,
    parseLocalMidnight,
} from './util/time.js';

const VELES_MUNICIPALITY_CODE = 'MK0010100';

const NOISE_RE =
    /урбанистички|(?<!\p{L})ДУП(?!\p{L})|јавен\s+увид|јавна\s+презентација|јавен\s+повик|тендер|оглас|субвенции|дератизација|дезинфекција|дезинсекција/iu;

const WATER_RE =
    /водовод|водоснабдување|вода\s+за\s+пиење|забрана\s+на\s+водата|водата\s+не\s+е\s+за\s+пиење|безбедност\s+на\s+водата|квалитет\s+на\s+водата|канализаци|резервоар|акумулација\s+младост|природни\s+чешми/iu;

const ROAD_RE =
    /времен\s+режим\s+на\s+сообраќај|сообраќај(?:от)?\s+(?:ќе\s+биде|е)\s+(?:прекинат|затворен|забранет|отежнат)|(?:прекинат|затворен)\s+сообраќај(?:от)?|затворени?\s+за\s+сообраќај|асфалтерски\s+работи|асфалтирање|хоризонтално\s+бел(?:ење|ежење)|бел(?:ење|ежење)\s+на\s+хоризонтална|реконструкција(?:та)?\s+на\s+(?:улица|улицата|улици|улиците|пат|патот)|лежечки\s+полицајци|градежни\s+активности\s+на\s+(?:улица|улицата|улици|улиците|пат|патот)/iu;

const OPEN_ENDED_BAN_RE =
    /с[èе]\s+до\s+укинување|до\s+укинување|не\s+е\s+за\s+пиење/iu;

const LAB_REPORT_RE =
    /извештај|тестирање|анализа\s+на\s+вода|безбедност\s+на\s+водата/iu;

const CLOSED_RE =
    /нормализиран|завршен|пуштен|поставени|укината|укинува(?!\p{L})|се\s+укинува|безбедна/iu;

const GENERIC_TITLE_RE = /^(?:известување|соопштение)\.?$/iu;

const OPEN_ENDED_BAN_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const UNDATED_WATER_TTL_MS = 3 * 24 * 60 * 60 * 1000;
const UNDATED_ROAD_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const CATEGORY_TITLES: Record<'water' | 'road', string> = {
    water: 'Известување за водоснабдување',
    road: 'Сообраќајно известување',
};

const LOCATION_RE =
    /((?:ул\.|улица(?!\s+во\s+село)|бул\.|булевар|нс\.|населба|с\.|село|селото|селата|трафостаница)\s+(?:Св\.|[^,.;:()–—])+?(?=\s+(?:е|ќе|во|од|за|до|поради|со|и)(?=\s|$)|[,.;:()–—]|$)|Акумулација\s+Младост|Езеро\s+Младост|река(?:та)?\s+Вардар|Бабуна|Тополка)/iu;

const LOCATION_STOP_WORDS_RE = /^(?:е|ќе|во|од|за|до|поради|со|и|низ)$/iu;

const MID_SENTENCE_CAPITALIZED_RE = /(?<=\s|„|“|"|\(|–|-)\p{Lu}\p{Ll}+/gu;

const LOCATION_WORD_RE = /\p{Lu}\p{Ll}+/gu;

const PROPER_NOUN_STOP_WORDS = new Set([
    'во',
    'ги',
    'до',
    'за',
    'из',
    'низ',
    'на',
    'но',
    'од',
    'по',
    'при',
    'со',
    'се',
    'или',
    'ул',
    'бул',
    'нс',
    'улица',
    'село',
    'селото',
    'селата',
    'булевар',
    'населба',
    'трафостаница',
    'акумулација',
    'езеро',
    'река',
]);

const SENTENCE_SPLIT_RE =
    /(?<=[.!?])(?<!(?<!\p{L})(?:ул|с|бр|г|год|св|т\.н)[.!?])\s+/iu;

const PR_SENTENCE_RE =
    /^(?:Општина\s+Велес\s+(?:континуирано|ги\s+замолува|продолжува)|Со\s+(?:оваа|овие\s+активности|реконструкцијата\s+на)|Реконструкцијата\s+се\s+реализираше)/iu;

const MULTI_DAY_WINDOW_RE =
    /од\s+(?:(\d{1,2}):(\d{2})\s*часот\s+)?(?:на\s+ден\s+)?(\d{1,2})\.(\d{1,2})\.(\d{4})(?:\s*год(?:ина|\.)?)?\s*(?:па\s+)?(?:с[еè]\s+)?до\s+(?:(\d{1,2}):(\d{2})\s*часот\s+)?(?:на\s+ден\s+)?(\d{1,2})\.(\d{1,2})\.(\d{4})(?:\s*год(?:ина|\.)?)?/iu;

const MONTH_DAY_RE =
    /на\s+(\d{1,2})\s+(јануари|февруари|март|април|мај|јуни|јули|август|септември|октомври|ноември|декември)\s+(\d{4})/iu;

const NUMERIC_DAY_RE = /(\d{1,2})\.(\d{1,2})\.(\d{4})/u;

const DAY_TIME_RE =
    /од\s+(\d{1,2})(?::(\d{2}))?\s*(?:часот\s+)?до\s+(\d{1,2})(?::(\d{2}))?/iu;

const MACEDONIAN_MONTHS: Record<string, number> = {
    јануари: 1,
    февруари: 2,
    март: 3,
    април: 4,
    мај: 5,
    јуни: 6,
    јули: 7,
    август: 8,
    септември: 9,
    октомври: 10,
    ноември: 11,
    декември: 12,
};

type EventWindow = {
    startsAt: Date;
    endsAt: Date | null;
    status: OpstinaVelesReportInsert['status'];
};

const pad2 = (value: number) => String(value).padStart(2, '0');

function formatIsoDay(year: string, month: string, day: string): string {
    return `${year}-${pad2(Number(month))}-${pad2(Number(day))}`;
}

export class OpstinaVelesStrategy
    implements ScrapingStrategy<OpstinaVelesItem[], OpstinaVelesReportInsert>
{
    readonly source: string;
    readonly url: string;
    readonly category: 'water' | 'road';
    readonly target = 'reports';
    readonly schedule: string;

    constructor(url: string, schedule: string, category: 'water' | 'road') {
        this.source = `opstina-veles-${category}`;
        this.url = url;
        this.schedule = schedule;
        this.category = category;
    }

    async fetch(): Promise<OpstinaVelesItem[]> {
        return fetchJson(this.url, opstinaVelesResponseSchema, {
            headers: { ...BROWSER_JSON_HEADERS },
        });
    }

    async parse(
        posts: OpstinaVelesItem[],
    ): Promise<OpstinaVelesReportInsert[]> {
        const now = new Date();
        const results: OpstinaVelesReportInsert[] = [];

        for (const post of posts) {
            const publishDate = this.parsePublishDate(post);
            if (!publishDate) continue;

            const title = this.cleanText(post.title.rendered);
            const body = this.cleanText(post.content.rendered);
            if (!body && !title) continue;

            if (this.classifyPost(title, body) !== this.category) continue;

            const location = this.extractLocation(title, body);

            results.push({
                externalId: hashExternalId(post.id),
                source: this.source,
                category: this.category,
                title: this.formatTitle(title, location, body),
                description: this.formatDescription(title, body),
                municipalityCode: VELES_MUNICIPALITY_CODE,
                locationLabel: this.formatLocationLabel(location),
                ...this.parseEventWindow(title, body, publishDate, now),
                observedAt: now,
                rawPayload: {
                    postId: post.id,
                    date: post.date.trim(),
                    dateGmt: post.date_gmt.trim(),
                    link: this.canonicalizeLink(post.link),
                    title,
                },
            });
        }

        return results;
    }

    private parsePublishDate(post: OpstinaVelesItem): Date | null {
        const gmtDate = new Date(`${post.date_gmt.trim()}Z`);
        if (!Number.isNaN(gmtDate.getTime())) return gmtDate;

        const day = extractIsoDay(post.date);
        if (!day) return null;

        const localDate = parseLocalMidnight(day);
        return Number.isNaN(localDate.getTime()) ? null : localDate;
    }

    private classifyPost(title: string, body: string): 'water' | 'road' | null {
        const combined = `${title} ${body}`;
        if (NOISE_RE.test(combined) || LAB_REPORT_RE.test(title)) {
            return null;
        }
        if (ROAD_RE.test(title) && !WATER_RE.test(title)) return 'road';
        if (WATER_RE.test(combined)) return 'water';
        if (ROAD_RE.test(combined)) return 'road';
        return null;
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

        const ttlMs =
            this.category === 'road'
                ? UNDATED_ROAD_TTL_MS
                : UNDATED_WATER_TTL_MS;
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

        const startHour = match[1] === undefined ? 0 : Number(match[1]);
        const startMinute = match[2] === undefined ? 0 : Number(match[2]);
        const endHour = match[6] === undefined ? 23 : Number(match[6]);
        const endMinute = match[7] === undefined ? 59 : Number(match[7]);
        const endSecond = match[6] === undefined ? 59 : 0;
        const endMs = match[6] === undefined ? 999 : 0;

        const start = buildLocalWindow(
            formatIsoDay(match[5] ?? '', match[4] ?? '', match[3] ?? ''),
            startHour,
            startMinute,
            startHour,
            startMinute,
        );
        const end = buildLocalWindow(
            formatIsoDay(match[10] ?? '', match[9] ?? '', match[8] ?? ''),
            endHour,
            endMinute,
            endHour,
            endMinute,
            endSecond,
            endMs,
        );

        if (!start || !end || end.endsAt <= start.startsAt) return null;
        return { startsAt: start.startsAt, endsAt: end.endsAt };
    }

    private parseSingleDayWindow(
        body: string,
    ): { startsAt: Date; endsAt: Date } | null {
        const day = this.extractEventDay(body);
        if (!day) return null;

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

    private extractEventDay(body: string): string | null {
        const monthMatch = body.match(MONTH_DAY_RE);
        if (monthMatch?.[2]) {
            const month = MACEDONIAN_MONTHS[monthMatch[2].toLowerCase()];
            if (month !== undefined) {
                return formatIsoDay(
                    monthMatch[3] ?? '',
                    String(month),
                    monthMatch[1] ?? '',
                );
            }
        }

        const numericMatch = body.match(NUMERIC_DAY_RE);
        if (numericMatch?.[1]) {
            return formatIsoDay(
                numericMatch[3] ?? '',
                numericMatch[2] ?? '',
                numericMatch[1] ?? '',
            );
        }

        return null;
    }

    private extractLocation(title: string, body: string): string | null {
        const match = title.match(LOCATION_RE) ?? body.match(LOCATION_RE);
        if (!match?.[1]) return null;

        let name = match[1];
        const allCaps = name === name.toUpperCase();
        let rest = match.input?.slice((match.index ?? 0) + match[0].length);

        for (;;) {
            const cont = /^\s+и\s+(\S+)/iu.exec(rest ?? '');
            if (!cont?.[1] || LOCATION_STOP_WORDS_RE.test(cont[1])) break;
            if (!/^\p{Lu}/u.test(cont[1]) && !allCaps) break;
            name = `${name} и ${cont[1]}`;
            rest = (rest ?? '').slice(cont[0].length);
        }

        const cleaned = name
            .replace(/["„“”]/g, '')
            .replace(/^(?:с\.|село|селото|селата)\s+/iu, '')
            .replace(/\s+/g, ' ')
            .replace(/[.,;:–—]+$/, '')
            .trim();
        if (!cleaned) return null;

        if (/Повеќе/iu.test(cleaned)) return null;

        if (allCaps && /\p{L}/u.test(cleaned)) {
            return toTitleCase(cleaned).replace(/\sИ\s/g, ' и ');
        }

        return cleaned;
    }

    private formatLocationLabel(location: string | null): string {
        const trimmed = location?.trim();
        if (!trimmed) return 'Велес';

        const normalized = trimmed.replace(
            /^(ул\.|улица|бул\.|булевар|нс\.|населба|трафостаница|река(?:та)?)(?=\s)/iu,
            (prefix) => prefix.toLowerCase(),
        );

        return /^велес$/iu.test(normalized) || /,\s*велес$/iu.test(normalized)
            ? normalized
            : `${normalized}, Велес`;
    }

    private formatTitle(
        postTitle: string,
        location: string | null,
        body: string,
    ): string {
        const trimmed = postTitle.trim();
        if (!trimmed || GENERIC_TITLE_RE.test(trimmed)) {
            return `${CATEGORY_TITLES[this.category]}: ${location ?? 'Велес'}`;
        }

        if (trimmed !== trimmed.toUpperCase()) {
            return trimmed;
        }

        const properNouns = this.collectProperNouns(location, body);
        return capitalizeFirst(
            trimmed
                .toLowerCase()
                .replace(/\p{L}+/gu, (word) => properNouns.get(word) ?? word),
        );
    }

    private collectProperNouns(
        location: string | null,
        body: string,
    ): Map<string, string> {
        const properNouns = new Map<string, string>();
        const add = (word: string): void => {
            const key = word.toLowerCase();
            if (!PROPER_NOUN_STOP_WORDS.has(key)) {
                properNouns.set(key, word);
            }
        };

        for (const word of body.match(MID_SENTENCE_CAPITALIZED_RE) ?? []) {
            add(word);
        }
        for (const word of (location ?? '').match(LOCATION_WORD_RE) ?? []) {
            add(word);
        }
        add('Велес');

        return properNouns;
    }

    private formatDescription(title: string, body: string): string {
        const prose =
            body
                .replace(/\s*Со\s+почит,?\s*Општина\s+Велес\s*\.?\s*$/iu, '')
                .trim() || title.trim();

        const sentences = prose
            .split(SENTENCE_SPLIT_RE)
            .map((sentence) => sentence.trim())
            .filter(Boolean);
        const informative = sentences.filter(
            (sentence) => !PR_SENTENCE_RE.test(sentence),
        );
        const pool =
            informative.length > 0 ? informative : [sentences.at(0) ?? ''];

        const [first = '', second] = pool;
        const selected =
            second !== undefined &&
            `${first} ${second}`.length > 280 &&
            first.length >= 40
                ? [first]
                : pool.slice(0, 2);

        return ensurePeriod(selected.join(' '));
    }

    private cleanText(raw: string): string {
        return decodeHtmlText(
            raw
                .replace(/<noscript>[\s\S]*?<\/noscript>/gi, '')
                .replace(/\u00a0/g, ' ')
                .replace(/&#8210;/g, '–'),
        );
    }

    private canonicalizeLink(link: string): string {
        return link
            .trim()
            .replace(
                /^https?:\/\/(?:www\.)?veles\.gov\.mk/iu,
                'https://www.veles.gov.mk',
            );
    }
}
