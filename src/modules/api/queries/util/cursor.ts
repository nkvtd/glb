import { type AnyColumn, type SQL, sql } from 'drizzle-orm';
import {
    decodeCursor,
    encodeCursor,
} from '../../validation/request/pagination.js';

export type CursorValueType = 'number' | 'date' | 'string';

export function buildCursorCondition(params: {
    cursor?: string | undefined;
    sortExpr: SQL | AnyColumn;
    idColumn: AnyColumn;
    sortDirection: 'asc' | 'desc';
    valueType: CursorValueType;
}): SQL | null {
    if (!params.cursor) return null;

    const decoded = decodeCursor(params.cursor);
    if (!decoded) return null;

    let parsedValue: number | string;

    if (params.valueType === 'number') {
        const num = Number(decoded.v);
        if (!Number.isInteger(num) || num <= 0) return null;
        parsedValue = num;
    } else if (params.valueType === 'date') {
        const date = new Date(String(decoded.v));
        if (Number.isNaN(date.getTime())) return null;
        parsedValue = date.toISOString();
    } else {
        if (typeof decoded.v !== 'string') return null;
        parsedValue = decoded.v;
    }

    return params.sortDirection === 'asc'
        ? sql`(${params.sortExpr}, ${params.idColumn}) > (${parsedValue}, ${decoded.id})`
        : sql`(${params.sortExpr}, ${params.idColumn}) < (${parsedValue}, ${decoded.id})`;
}

export function buildPaginatedResponse<T extends { id: number }, TDto>(
    rows: T[],
    pageSize: number,
    getSortValue: (row: T) => number | string,
    toDto: (row: T) => TDto,
) {
    const hasNextPage = rows.length > pageSize;
    const pageRows = hasNextPage ? rows.slice(0, pageSize) : rows;
    const lastRow = pageRows[pageRows.length - 1];

    const nextCursor =
        hasNextPage && lastRow
            ? encodeCursor({
                  v: getSortValue(lastRow),
                  id: lastRow.id,
              })
            : null;

    return {
        data: pageRows.map(toDto),
        meta: {
            nextCursor,
            hasNextPage,
        },
    };
}
