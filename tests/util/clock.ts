// The strategies read the wall clock internally, so 1 ms window boundaries can
// only be asserted deterministically against a frozen clock.
export async function withFrozenClock<T>(
    frozenAt: Date,
    fn: () => Promise<T>,
): Promise<T> {
    const fixedMs = frozenAt.getTime();
    const RealDate = globalThis.Date;
    class FrozenDate extends RealDate {
        constructor(value?: number | string | Date) {
            super(
                value === undefined
                    ? fixedMs
                    : value instanceof Date
                      ? value.getTime()
                      : value,
            );
        }
    }
    globalThis.Date = FrozenDate as unknown as DateConstructor;
    FrozenDate.now = () => fixedMs;
    try {
        return await fn();
    } finally {
        globalThis.Date = RealDate;
    }
}

export function localCalendarDate(date: Date): string {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Europe/Skopje',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).format(date);
}
