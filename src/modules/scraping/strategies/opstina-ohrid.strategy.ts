import type { OpstinaOhridReportInsert } from '../../../core/types/opstina-ohrid.js';
import {
    type OpstinaOhridItem,
    opstinaOhridResponseSchema,
} from '../../../core/validation/opstina-ohrid.js';
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

const OHRID_MUNICIPALITY_CODE = 'MK0031000';

const BAN_TITLE_RE = /ЗАБРАНА\s+ЗА\s+КОРИСТЕЊЕ.*ВОДА/iu;

const BAN_BODY_RE = /ВОДАТА\s+НЕ\s+Е\s+ЗА\s+ПИЕЊЕ/iu;

const ROAD_TITLE_RE =
    /ЗАТВОРЕНА?\s+ЗА\s+СООБРАЌАЈ|ВРЕМЕНО\s+ЗАТВОРАЊЕ|ВРЕМЕН\s+РЕЖИМ\s+НА\s+СООБРАЌАЈ|ВРЕМЕНА\s+ЗАБРАНА\s+ЗА\s+СООБРАЌАЈ|АСФАЛТИРАЊЕ/iu;

const ROAD_BODY_RE = /пат(?:ниот)?\s+правец/iu;

const ROAD_NOISE_RE =
    /ДЕН\s+БЕЗ\s+АВТОМОБИЛИ|ОРГАНИЗИРАН\s+ПРЕВОЗ|ГРАДЕЖНИ\s+РАБОТИ\s+ВО\s+ДВОРОТ|ГАРАЖИ/iu;

const CLOSED_RE = /нормализиран|завршен|пуштен|укинат/iu;

const LOCATION_TAIL_RE = /.*(?<!\p{L})ВО\s+([^,.;:]+)$/iu;

const PLACE_TAIL_RE = /ВО\s+([^,.;:–—]+)$/iu;

const DASH_TAIL_RE = /[–—]\s*([^–—]+)$/u;

const STREET_RE = /(?:УЛИЦАТА|УЛИЦА|УЛ\.)\s*[„"“]([^„“”"]+)[“”"]/iu;

const MULTI_DAY_WINDOW_RE =
    /од(?:\s+денес)?\s+(\d{1,2})\.(\d{1,2})\.(\d{4})[\s\S]{0,120}?до\s+(\d{1,2})\.(\d{1,2})\.(\d{4})/iu;

const NUMERIC_DAY_RE = /(\d{1,2})\.(\d{1,2})\.(\d{4})/u;

const DAY_RANGE_RE = /од\s+(\d{1,2}):(\d{2})\s*до\s+(\d{1,2}):(\d{2})/iu;

const START_TIME_RE = /со\s+почеток\s+во\s+(\d{1,2}):(\d{2})/iu;

const OPEN_ENDED_TIME_RE = /од\s+(\d{1,2}):(\d{2})\s*часот/iu;

const OPEN_ENDED_RE = /до\s+завршување|па\s+се\s+до/iu;

const OPEN_ENDED_BAN_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const UNDATED_ROAD_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const MUNICIPALITY_NAME = 'Охрид';

type EventWindow = {
    startsAt: Date;
    endsAt: Date | null;
    status: OpstinaOhridReportInsert['status'];
};

export class OpstinaOhridStrategy
    implements ScrapingStrategy<OpstinaOhridItem[], OpstinaOhridReportInsert>
{
    readonly source = 'opstina-ohrid';
    readonly url: string;
    readonly target = 'reports';
    readonly schedule: string;

    constructor(url: string, schedule: string) {
        this.url = url;
        this.schedule = schedule;
    }

    async fetch(): Promise<OpstinaOhridItem[]> {
        return fetchJson(this.url, opstinaOhridResponseSchema, {
            headers: { ...BROWSER_JSON_HEADERS },
        });
    }

    async parse(
        posts: OpstinaOhridItem[],
    ): Promise<OpstinaOhridReportInsert[]> {
        const now = new Date();
        const results: OpstinaOhridReportInsert[] = [];

        for (const post of posts) {
            const publishDate = parseWordPressPublishDate(post);
            if (!publishDate) continue;

            const title = this.cleanText(post.title.rendered);
            const body = this.cleanText(post.content.rendered);
            if (!body && !title) continue;

            const category = this.classifyPost(title, body);
            if (!category) continue;

            const location =
                category === 'road'
                    ? this.extractRoadLocation(title, body)
                    : this.extractLocation(title);

            results.push({
                externalId: hashExternalId(post.id),
                source: this.source,
                category,
                title: this.formatTitle(category, title, body, location),
                description: formatSummarySentences(
                    splitSentences(body || title),
                ),
                municipalityCode: OHRID_MUNICIPALITY_CODE,
                locationLabel: this.formatLocationLabel(location),
                ...(category === 'road'
                    ? this.parseRoadWindow(title, body, publishDate, now)
                    : this.parseWaterWindow(title, body, publishDate, now)),
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

    private classifyPost(title: string, body: string): 'water' | 'road' | null {
        if (ROAD_NOISE_RE.test(`${title} ${body}`)) return null;
        if (BAN_TITLE_RE.test(title) && BAN_BODY_RE.test(body)) return 'water';
        if (
            ROAD_TITLE_RE.test(title) ||
            ROAD_BODY_RE.test(`${title} ${body}`)
        ) {
            return 'road';
        }
        return null;
    }

    private parseWaterWindow(
        title: string,
        body: string,
        publishDate: Date,
        now: Date,
    ): EventWindow {
        const isClosed = CLOSED_RE.test(`${title} ${body}`);

        return {
            startsAt: publishDate,
            endsAt: null,
            status:
                isClosed ||
                now.getTime() - publishDate.getTime() > OPEN_ENDED_BAN_TTL_MS
                    ? 'ended'
                    : 'ongoing',
        };
    }

    private parseRoadWindow(
        title: string,
        body: string,
        publishDate: Date,
        now: Date,
    ): EventWindow {
        const isClosed = CLOSED_RE.test(`${title} ${body}`);

        const multiDay = this.parseMultiDayWindow(body);
        if (multiDay) {
            return {
                ...multiDay,
                status: deriveLifecycleStatus(
                    now,
                    multiDay.startsAt,
                    multiDay.endsAt,
                    { closed: isClosed },
                ),
            };
        }

        const day = this.extractEventDay(body);
        if (day && OPEN_ENDED_RE.test(body)) {
            const startsAt = this.buildStart(day, body);
            return {
                startsAt,
                endsAt: null,
                status: deriveLifecycleStatus(now, startsAt, null, {
                    closed:
                        isClosed ||
                        now.getTime() - startsAt.getTime() >
                            UNDATED_ROAD_TTL_MS,
                }),
            };
        }

        if (day) {
            const window = this.parseSingleDayWindow(day, body);
            if (window) {
                return {
                    ...window,
                    status: deriveLifecycleStatus(
                        now,
                        window.startsAt,
                        window.endsAt,
                        { closed: isClosed },
                    ),
                };
            }
        }

        return {
            startsAt: publishDate,
            endsAt: null,
            status:
                isClosed ||
                now.getTime() - publishDate.getTime() > UNDATED_ROAD_TTL_MS
                    ? 'ended'
                    : 'ongoing',
        };
    }

    private parseMultiDayWindow(
        body: string,
    ): { startsAt: Date; endsAt: Date } | null {
        const match = body.match(MULTI_DAY_WINDOW_RE);
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
            0,
            0,
            23,
            59,
            59,
            999,
        );

        if (!start || !end || end.endsAt <= start.startsAt) return null;
        return { startsAt: start.startsAt, endsAt: end.endsAt };
    }

    private parseSingleDayWindow(
        day: string,
        body: string,
    ): { startsAt: Date; endsAt: Date } | null {
        const range = body.match(DAY_RANGE_RE);
        if (range?.[1] && range[3]) {
            return buildLocalWindow(
                day,
                Number(range[1]),
                Number(range[2]),
                Number(range[3]),
                Number(range[4]),
            );
        }

        const startTime = body.match(START_TIME_RE);
        if (startTime?.[1]) {
            return buildLocalWindow(
                day,
                Number(startTime[1]),
                Number(startTime[2]),
                23,
                59,
                59,
                999,
            );
        }

        return buildLocalWindow(day, 0, 0, 23, 59, 59, 999);
    }

    private buildStart(day: string, body: string): Date {
        const time = body.match(OPEN_ENDED_TIME_RE);
        const hour = time?.[1] === undefined ? 0 : Number(time[1]);
        const minute = time?.[2] === undefined ? 0 : Number(time[2]);
        const window = buildLocalWindow(day, hour, minute, hour, minute);

        return window?.startsAt ?? new Date(`${day}T00:00:00Z`);
    }

    private extractEventDay(body: string): string | null {
        const match = body.match(NUMERIC_DAY_RE);
        if (!match?.[1]) return null;

        return formatIsoDay(match[3] ?? '', match[2] ?? '', match[1] ?? '');
    }

    private extractLocation(title: string): string {
        const tail = title.match(LOCATION_TAIL_RE)?.[1]?.trim() ?? '';
        if (!tail) return MUNICIPALITY_NAME;

        const cased =
            tail === tail.toUpperCase() && /\p{L}/u.test(tail)
                ? toTitleCase(tail).replace(/\sИ\s/g, ' и ')
                : tail;

        return cased.replace(/[.,;:]+$/u, '').trim() || MUNICIPALITY_NAME;
    }

    private extractRoadLocation(title: string, body: string): string {
        const dash = ROAD_TITLE_RE.test(title)
            ? undefined
            : title.match(DASH_TAIL_RE)?.[1];
        if (dash) return this.cleanName(dash);

        const street = this.formatStreetName(
            body.match(STREET_RE)?.[1],
            title.match(STREET_RE)?.[1],
        );
        if (street) return `улица „${street}“`;

        const tail = title.match(PLACE_TAIL_RE)?.[1]?.trim();
        if (tail) return tail.toLowerCase();

        return MUNICIPALITY_NAME;
    }

    private formatStreetName(
        bodyName: string | undefined,
        titleName: string | undefined,
    ): string | null {
        const mixed = [bodyName, titleName].find(
            (name) => name !== undefined && /\p{Ll}/u.test(name),
        );
        const name = mixed ?? bodyName ?? titleName;
        if (!name) return null;

        const normalized = name
            .replace(/\s+/g, ' ')
            .replace(/(\d)\s*-\s*(?=\p{L})/gu, '$1-')
            .replace(/[.,;:]+$/u, '')
            .trim();
        if (!normalized) return null;

        return /\p{Ll}/u.test(normalized)
            ? normalized
            : toTitleCase(normalized).replace(/\sИ\s/gu, ' и ');
    }

    private cleanName(name: string): string {
        const cleaned = name.replace(/[.,;:]+$/u, '').trim();
        return cleaned === cleaned.toUpperCase() && /\p{L}/u.test(cleaned)
            ? toTitleCase(cleaned).replace(/\sИ\s/gu, ' и ')
            : cleaned;
    }

    private formatLocationLabel(location: string): string {
        return location.endsWith(MUNICIPALITY_NAME)
            ? location
            : `${location}, ${MUNICIPALITY_NAME}`;
    }

    private formatTitle(
        category: 'water' | 'road',
        title: string,
        body: string,
        location: string,
    ): string {
        if (category === 'water') {
            return `Забрана за вода за пиење: ${location}`;
        }

        const combined = `${title} ${body}`;
        if (/АСФАЛТИРАЊЕ/iu.test(combined)) {
            return `Реконструкција на улица: ${location}`;
        }
        if (ROAD_TITLE_RE.test(title)) {
            return `Времен режим на сообраќај: ${location}`;
        }
        return `Сообраќајно известување: ${location}`;
    }

    private cleanText(raw: string): string {
        return decodeHtmlText(
            raw
                .replace(/<svg[\s\S]*?<\/svg>/gi, '')
                .replace(/<h[1-6][^>]*>[\s\S]*?<\/h[1-6]>/gi, '')
                .replace(
                    /<p[^>]*class="[^"]*post-date[^"]*"[^>]*>[\s\S]*?<\/p>/gi,
                    '',
                )
                .replace(
                    /<span[^>]*class="[^"]*term-list[^"]*"[^>]*>[\s\S]*?<\/span>/gi,
                    '',
                )
                .replace(/\u00a0/g, ' '),
        );
    }
}
