const LOCAL_TIME_ZONE = 'Europe/Skopje';

const LOCAL_DATE_FORMATTER = new Intl.DateTimeFormat('en-CA', {
    timeZone: LOCAL_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
});

const LOCAL_OFFSET_FORMATTER = new Intl.DateTimeFormat('en-US', {
    timeZone: LOCAL_TIME_ZONE,
    timeZoneName: 'longOffset',
});

export function formatLocalDate(date: Date): string {
    const parts = LOCAL_DATE_FORMATTER.formatToParts(date);
    const year = parts.find((part) => part.type === 'year')?.value ?? '';
    const month = parts.find((part) => part.type === 'month')?.value ?? '';
    const day = parts.find((part) => part.type === 'day')?.value ?? '';
    return `${year}-${month}-${day}`;
}

export function getLocalOffset(utcProbe: Date): string {
    const tzPart =
        LOCAL_OFFSET_FORMATTER.formatToParts(utcProbe).find(
            (part) => part.type === 'timeZoneName',
        )?.value ?? 'GMT+01:00';

    const offset = tzPart.replace('GMT', '');
    return /^[+-]\d{2}:\d{2}$/.test(offset) ? offset : '+01:00';
}

export function extractIsoDay(rawDate: string): string | null {
    return rawDate.trim().match(/^(\d{4}-\d{2}-\d{2})/)?.[1] ?? null;
}

export function parseLocalMidnight(date: string): Date {
    const offset = getLocalOffset(new Date(`${date}T00:00:00Z`));
    return new Date(`${date}T00:00:00.000${offset}`);
}

export function formatIsoDay(year: string, month: string, day: string): string {
    return `${year}-${String(Number(month)).padStart(2, '0')}-${String(Number(day)).padStart(2, '0')}`;
}

export function parseWordPressPublishDate(post: {
    date: string;
    date_gmt: string;
}): Date | null {
    const gmtDate = new Date(`${post.date_gmt.trim()}Z`);
    if (!Number.isNaN(gmtDate.getTime())) return gmtDate;

    const day = extractIsoDay(post.date);
    if (!day) return null;

    const localDate = parseLocalMidnight(day);
    return Number.isNaN(localDate.getTime()) ? null : localDate;
}

export function buildLocalWindow(
    day: string,
    startHour: number,
    startMinute: number,
    endHour: number,
    endMinute: number,
    endSecond = 0,
    endMs = 0,
): { startsAt: Date; endsAt: Date } | null {
    const startProbe = new Date(`${day}T00:00:00Z`);
    const endProbe = new Date(`${day}T21:00:00Z`);

    if (
        Number.isNaN(startProbe.getTime()) ||
        Number.isNaN(endProbe.getTime())
    ) {
        return null;
    }

    const startOffset = getLocalOffset(startProbe);
    const endOffset = getLocalOffset(endProbe);

    const pad2 = (n: number) => String(n).padStart(2, '0');
    const pad3 = (n: number) => String(n).padStart(3, '0');

    const startsAt = new Date(
        `${day}T${pad2(startHour)}:${pad2(startMinute)}:00.000${startOffset}`,
    );
    const endsAt = new Date(
        `${day}T${pad2(endHour)}:${pad2(endMinute)}:${pad2(endSecond)}.${pad3(endMs)}${endOffset}`,
    );

    if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) {
        return null;
    }

    return { startsAt, endsAt };
}

export function floorToUtcHourIso(date: Date): string {
    return `${date.toISOString().slice(0, 13)}:00:00Z`;
}

export function deriveLifecycleStatus(
    now: Date,
    startsAt: Date,
    endsAt: Date | null,
    options?: { closed?: boolean; inclusiveEnd?: boolean },
): 'scheduled' | 'ongoing' | 'ended' {
    if (options?.closed === true) {
        return 'ended';
    }

    if (endsAt !== null) {
        if (options?.inclusiveEnd === false) {
            if (now >= endsAt) {
                return 'ended';
            }
        } else if (now > endsAt) {
            return 'ended';
        }
    }

    return now < startsAt ? 'scheduled' : 'ongoing';
}
