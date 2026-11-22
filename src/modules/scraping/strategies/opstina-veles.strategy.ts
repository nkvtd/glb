import type { OpstinaVelesReportInsert } from '../../../core/types/opstina-veles.js';
import {
    type OpstinaVelesItem,
    opstinaVelesResponseSchema,
} from '../../../core/validation/opstina-veles.js';
import type { ScrapingStrategy } from '../strategy.interface.js';
import { BROWSER_JSON_HEADERS, fetchJson } from './util/fetch.js';
import { hashExternalId } from './util/hash.js';
import {
    decodeHtmlText,
    formatSummarySentences,
    splitSentences,
    toTitleCase,
} from './util/text.js';
import {
    buildLocalWindow,
    deriveLifecycleStatus,
    formatIsoDay,
    parseWordPressPublishDate,
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

const OPEN_ENDED_BAN_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const UNDATED_WATER_TTL_MS = 3 * 24 * 60 * 60 * 1000;
const UNDATED_ROAD_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const LOCATION_RE =
    /((?:ул\.|улица(?!\s+во\s+село)|бул\.|булевар|нс\.|населба|с\.|село|селото|селата|трафостаница)\s+(?:Св\.|[^,.;:()–—])+?(?=\s+(?:е|ќе|во|од|за|до|поради|со|и)(?=\s|$)|[,.;:()–—]|$)|Акумулација\s+Младост|Езеро\s+Младост|река(?:та)?\s+Вардар|Бабуна|Тополка)/iu;

const LOCATION_STOP_WORDS_RE = /^(?:е|ќе|во|од|за|до|поради|со|и|низ)$/iu;

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

export class OpstinaVelesStrategy
    implements ScrapingStrategy<OpstinaVelesItem[], OpstinaVelesReportInsert>
{
    readonly source = 'opstina-veles';
    readonly url: string;
    readonly target = 'reports';
    readonly schedule: string;

    constructor(url: string, schedule: string) {
        this.url = url;
        this.schedule = schedule;
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
            const publishDate = parseWordPressPublishDate(post);
            if (!publishDate) continue;

            const title = this.cleanText(post.title.rendered);
            const body = this.cleanText(post.content.rendered);
            if (!body && !title) continue;

            const category = this.classifyPost(title, body);
            if (!category) continue;

            const location = this.extractLocation(title, body);
            const locationLabel = this.formatLocationLabel(location);

            results.push({
                externalId: hashExternalId(post.id),
                source: this.source,
                category,
                title: this.formatTitle(
                    category,
                    title,
                    body,
                    location ?? 'Велес',
                ),
                description: this.formatDescription(title, body),
                municipalityCode: VELES_MUNICIPALITY_CODE,
                locationLabel,
                ...this.parseEventWindow(
                    category,
                    title,
                    body,
                    publishDate,
                    now,
                ),
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
        category: 'water' | 'road',
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
            category === 'road' ? UNDATED_ROAD_TTL_MS : UNDATED_WATER_TTL_MS;
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

        const cased =
            allCaps && /\p{L}/u.test(cleaned)
                ? toTitleCase(cleaned).replace(/\sИ\s/g, ' и ')
                : cleaned;

        return cased.replace(
            /^(ул\.|улица|бул\.|булевар|нс\.|населба|трафостаница|река(?:та)?)(?=\s)/iu,
            (prefix) => prefix.toLowerCase(),
        );
    }

    private formatLocationLabel(location: string | null): string {
        const trimmed = location?.trim();
        if (!trimmed) return 'Велес';

        return /^велес$/iu.test(trimmed) || /,\s*велес$/iu.test(trimmed)
            ? trimmed
            : `${trimmed}, Велес`;
    }

    private formatTitle(
        category: 'water' | 'road',
        title: string,
        body: string,
        location: string,
    ): string {
        const combined = `${title} ${body}`;

        if (category === 'water') {
            if (OPEN_ENDED_BAN_RE.test(combined)) {
                return `Забрана за вода за пиење: ${location}`;
            }
            if (/прекин/iu.test(combined)) {
                return `Прекин во водоснабдувањето: ${location}`;
            }
            if (/реконструкција/iu.test(combined)) {
                return `Реконструкција на водоводна мрежа: ${location}`;
            }
            return `Водоснабдување: ${location}`;
        }

        if (/времен\s+режим|прекинат\s+сообраќај|затворен/iu.test(combined)) {
            return `Времен режим на сообраќај: ${location}`;
        }
        if (
            /хоризонтално\s+бел|бел(?:ење|ежење)\s+на\s+хоризонтална/iu.test(
                combined,
            )
        ) {
            return `Хоризонтално бележење на улици: ${location}`;
        }
        if (/лежечки\s+полицајци/iu.test(combined)) {
            return `Поставена сообраќајна сигнализација: ${location}`;
        }
        if (/реконструкција|асфалт|градежни\s+активности/iu.test(combined)) {
            return `Реконструкција на улица: ${location}`;
        }
        return `Сообраќајно известување: ${location}`;
    }

    private formatDescription(title: string, body: string): string {
        const prose =
            body
                .replace(/\s*Со\s+почит,?\s*Општина\s+Велес\s*\.?\s*$/iu, '')
                .trim() || title.trim();

        const sentences = splitSentences(prose);
        const informative = sentences.filter(
            (sentence) => !PR_SENTENCE_RE.test(sentence),
        );
        const pool =
            informative.length > 0 ? informative : [sentences.at(0) ?? ''];

        return formatSummarySentences(pool);
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
