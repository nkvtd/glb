import type { SQL } from 'drizzle-orm';
import type { EventItem, ReportItem } from '../../src/core/schema.js';
import type { AlertDispatcher } from '../../src/infrastructure/alerting/dispatcher.js';
import type { DbOrTx } from '../../src/infrastructure/database/db.js';
import type { MunicipalityResolver } from '../../src/modules/scraping/resolver.js';
import { sqlParams } from './assertions.js';

export type FakeResolverOverrides = {
    /** Exact-match map for `resolveText`, or a custom callback. */
    text?: Map<string, string> | ((text?: string | null) => string | null);
    /** Fixed result for every `resolveCoords` call, or a custom callback. */
    coords?:
        | { code: string; name: string }
        | null
        | ((
              lng?: number | null,
              lat?: number | null,
          ) => Promise<{ code: string; name: string } | null>);
    /** Fixed list for every `resolveRegion` call, or a custom callback. */
    region?:
        | Array<{ code: string; nameMk: string }>
        | ((
              regionCode?: string | null,
          ) => Array<{ code: string; nameMk: string }>);
};

export function createFakeResolver(
    overrides: FakeResolverOverrides = {},
): MunicipalityResolver {
    const resolveText = (text?: string | null): string | null => {
        if (typeof overrides.text === 'function') return overrides.text(text);
        if (overrides.text instanceof Map) {
            return text ? (overrides.text.get(text) ?? null) : null;
        }
        return null;
    };

    const resolveCoords = (
        lng?: number | null,
        lat?: number | null,
    ): Promise<{ code: string; name: string } | null> => {
        if (typeof overrides.coords === 'function') {
            return overrides.coords(lng, lat);
        }
        return Promise.resolve(overrides.coords ?? null);
    };

    const resolveRegion = (
        regionCode?: string | null,
    ): Array<{ code: string; nameMk: string }> => {
        if (typeof overrides.region === 'function') {
            return overrides.region(regionCode);
        }
        return overrides.region ?? [];
    };

    return {
        init: async () => {},
        resolveText,
        resolveCoords,
        resolveRegion,
    } as unknown as MunicipalityResolver;
}

export function createStandardFakeResolver(): MunicipalityResolver {
    return createFakeResolver({
        text: (raw) => {
            if (!raw) return null;
            const upper = raw.toUpperCase();
            if (upper.includes('АЕРОДРОМ')) return 'MK0080901';
            if (upper.includes('КАРПОШ')) return 'MK0080907';
            if (upper.includes('ГАЗИ БАБА')) return 'MK0080904';
            if (upper.includes('МАВРОВО')) return 'MK0060401';
            return null;
        },
        coords: async (lng, lat) => {
            if (!lng || !lat) return null;
            if (lng > 21.3 && lng < 21.6 && lat > 41.9 && lat < 42.1) {
                return { code: 'MK0080907', name: 'Карпош' };
            }
            return null;
        },
        region: (regionCode) =>
            regionCode === 'MK008'
                ? [
                      { code: 'MK0080901', nameMk: 'Аеродром' },
                      { code: 'MK0080904', nameMk: 'Гази Баба' },
                  ]
                : [],
    });
}

export type ResolverRow = {
    code: string;
    nameMk: string;
    nameEn: string;
    regionCode: string;
};

export function createResolverDb(rows: readonly ResolverRow[]) {
    let selectCount = 0;
    let coordinateRows: Array<{ code: string; name: string }> = [];

    const db = {
        select: () => ({
            from: () => {
                const isInitQuery = selectCount++ === 0;
                if (isInitQuery) return Promise.resolve(rows);
                return {
                    where: () => ({ limit: async () => coordinateRows }),
                };
            },
        }),
    } as unknown as DbOrTx;

    return {
        db,
        get selectCount() {
            return selectCount;
        },
        setCoordinateRows(value: Array<{ code: string; name: string }>) {
            coordinateRows = value;
        },
    };
}

export type QueryCapture = {
    db: DbOrTx;
    capture: {
        where?: SQL;
        orderBy: unknown[];
        limit?: number;
        selectedKeys: string[];
    };
};

export function queryCapture(rows: unknown[] = []): QueryCapture {
    const capture: {
        where?: SQL;
        orderBy: unknown[];
        limit?: number;
        selectedKeys: string[];
    } = { orderBy: [], selectedKeys: [] };
    const chain = {
        where(value: SQL) {
            capture.where = value;
            return chain;
        },
        orderBy(...values: unknown[]) {
            capture.orderBy = values;
            return chain;
        },
        limit(value: number) {
            capture.limit = value;
            return Promise.resolve(rows);
        },
    };
    const db = {
        select: (columns?: unknown) => {
            capture.selectedKeys =
                columns && typeof columns === 'object'
                    ? Object.keys(columns)
                    : [];
            return { from: () => chain };
        },
    } as unknown as DbOrTx;
    return { db, capture };
}

export type ExistingReportRow = {
    id: number;
    externalId: string;
    locationLabel: string | null;
    status: 'ongoing' | 'omitted' | 'scheduled' | 'ended' | 'unknown';
};

export type ReportDbOptions = {
    incomingExisting?: Array<{
        externalId: string;
        status?: ExistingReportRow['status'];
        endsAt?: Date | null;
    }>;
    activeRows?: ExistingReportRow[];
};

export type FakeUpdateValues = {
    [key: string]: unknown;
    status?: unknown;
    endsAt?: unknown;
};

export type FakeInsertedRow = Record<string, unknown> & {
    id: number;
    externalId?: string;
    locationLabel?: string | null;
};

export function createReportDb(options: ReportDbOptions = {}) {
    const state = {
        selected: 0,
        insertedRows: [] as FakeInsertedRow[],
        updatedCount: 0,
        endedIds: [] as number[],
    };

    const existingRows = (options.incomingExisting ?? []).map((row) => ({
        externalId: row.externalId,
        status: row.status ?? 'ongoing',
        endsAt: row.endsAt ?? null,
    }));

    const tx = {
        select: () => ({
            from: () => ({
                where: async () =>
                    state.selected++ === 0
                        ? existingRows
                        : (options.activeRows ?? []),
            }),
        }),
        update: () => ({
            set: (values: FakeUpdateValues) => ({
                where: (condition: SQL) => {
                    state.updatedCount += 1;
                    if (
                        values.status === 'ended' &&
                        !('observedAt' in values)
                    ) {
                        state.endedIds.push(
                            ...sqlParams(condition).filter(
                                (param): param is number =>
                                    typeof param === 'number',
                            ),
                        );
                    }
                    return {
                        returning: async () => [],
                    };
                },
            }),
        }),
        insert: () => ({
            values: (rows: Array<Record<string, unknown>>) => {
                state.insertedRows = rows as FakeInsertedRow[];
                return {
                    onConflictDoNothing: () => ({
                        returning: async () =>
                            rows.map((row, index) => ({
                                id: index + 100,
                                ...row,
                            })),
                    }),
                };
            },
        }),
    };

    const db = {
        transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx),
    } as unknown as DbOrTx;

    return { db, state };
}

export type ExistingEventRow = {
    id: number;
    externalId: string;
    status: 'ongoing' | 'omitted' | 'scheduled' | 'ended' | 'unknown';
};

export type EventDbOptions = {
    incomingExisting?: Array<{
        externalId: string;
        status?: ExistingEventRow['status'];
        endsAt?: Date | null;
    }>;
    activeRows?: ExistingEventRow[];
};

export function createEventDb(options: EventDbOptions = {}) {
    const state = {
        selected: 0,
        insertedRows: [] as FakeInsertedRow[],
        updatedCount: 0,
        endedIds: [] as number[],
    };
    const existingRows = (options.incomingExisting ?? []).map((row) => ({
        externalId: row.externalId,
        status: row.status ?? 'ongoing',
        endsAt: row.endsAt ?? null,
    }));
    const tx = {
        select: () => ({
            from: () => ({
                where: async () =>
                    state.selected++ === 0
                        ? existingRows
                        : (options.activeRows ?? []),
            }),
        }),
        update: () => ({
            set: (values: FakeUpdateValues) => ({
                where: (condition: SQL) => {
                    state.updatedCount += 1;
                    if (
                        values.status === 'ended' &&
                        !('observedAt' in values)
                    ) {
                        state.endedIds.push(
                            ...sqlParams(condition).filter(
                                (param): param is number =>
                                    typeof param === 'number',
                            ),
                        );
                    }
                    return {
                        returning: async () => [],
                    };
                },
            }),
        }),
        insert: () => ({
            values: (rows: Array<Record<string, unknown>>) => {
                state.insertedRows = rows as FakeInsertedRow[];
                return {
                    onConflictDoNothing: () => ({
                        returning: async () =>
                            rows.map((row, index) => ({
                                id: index + 1,
                                ...row,
                            })),
                    }),
                };
            },
        }),
    };
    return {
        db: {
            transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx),
        } as unknown as DbOrTx,
        state,
    };
}

export function createDispatcher() {
    const batches: Array<{
        source: string;
        items: Array<ReportItem | EventItem>;
    }> = [];
    const dispatcher = {
        dispatch: async (
            source: string,
            items: Array<ReportItem | EventItem>,
        ) => {
            batches.push({ source, items });
        },
    } as unknown as AlertDispatcher;
    return { dispatcher, batches };
}

export function alertItem(
    overrides: Record<string, unknown> = {},
    includeLocation = true,
) {
    return {
        id: 1,
        externalId: 'e-1',
        source: 'test',
        category: 'water',
        title: 'A title'.repeat(40),
        description: 'A description'.repeat(400),
        status: 'ongoing',
        observedAt: new Date('2026-10-25T00:00:00.000Z'),
        startsAt: new Date('2026-10-25T01:00:00.000Z'),
        endsAt: new Date('2026-10-25T02:00:00.000Z'),
        ...(includeLocation ? { locationLabel: 'Карпош' } : {}),
        ...overrides,
    } as unknown as ReportItem | EventItem;
}
