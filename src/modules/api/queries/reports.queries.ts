import {
    and,
    asc,
    desc,
    eq,
    getTableColumns,
    gte,
    ilike,
    inArray,
    lte,
    or,
    type SQL,
    sql,
} from 'drizzle-orm';
import {
    municipalities,
    type ReportItem,
    reports,
} from '../../../core/schema.js';
import type { DbOrTx } from '../../../infrastructure/database/db.js';
import type { ReportsQuery } from '../validation/request/report.js';
import { type ReportDto, toReportDto } from '../validation/response/report.js';
import { buildCursorCondition, buildPaginatedResponse } from './util/cursor.js';
import { buildContainsPattern } from './util/ilike.js';

const { geom, ...reportColumns } = getTableColumns(reports);

const reportSelect = {
    ...reportColumns,
    lng: sql<number | null>`ST_X(${reports.geom})`,
    lat: sql<number | null>`ST_Y(${reports.geom})`,
};

export async function findReportById(
    db: DbOrTx,
    id: number,
): Promise<ReportDto | null> {
    const [row] = await db
        .select(reportSelect)
        .from(reports)
        .where(eq(reports.id, id))
        .limit(1);

    return row ? toReportDto(row) : null;
}

export async function findReports(db: DbOrTx, query: ReportsQuery) {
    const conditions: SQL[] = [];

    if (query.status) {
        conditions.push(inArray(reports.status, query.status));
    }

    if (query.category) {
        conditions.push(inArray(reports.category, query.category));
    }

    if (query.source) {
        conditions.push(eq(reports.source, query.source));
    }

    if (query.municipalityCode) {
        conditions.push(eq(reports.municipalityCode, query.municipalityCode));
    }

    if (query.search) {
        const pattern = buildContainsPattern(query.search);
        const searchCondition = or(
            ilike(reports.title, pattern),
            ilike(reports.description, pattern),
            ilike(reports.locationLabel, pattern),
        );
        if (searchCondition) {
            conditions.push(searchCondition);
        }
    }

    if (query.from) {
        conditions.push(
            gte(
                sql`COALESCE(${reports.startsAt}, ${reports.observedAt})`,
                query.from.toISOString(),
            ),
        );
    }

    if (query.to) {
        conditions.push(
            lte(
                sql`COALESCE(${reports.startsAt}, ${reports.observedAt})`,
                query.to.toISOString(),
            ),
        );
    }

    if (query.lat !== undefined && query.lng !== undefined) {
        const radiusMeters = query.radius ?? 5000;
        const userPoint = sql`ST_SetSRID(ST_MakePoint(${query.lng}, ${query.lat}), 4326)::geography`;

        conditions.push(sql`(
            (${reports.geom} IS NOT NULL AND ST_DWithin(${reports.geom}::geography, ${userPoint}, ${radiusMeters}))
            OR (
                ${reports.geom} IS NULL
                AND ${reports.municipalityCode} IS NOT NULL
                AND EXISTS (
                    SELECT 1 FROM ${municipalities}
                    WHERE ${municipalities.code} = ${reports.municipalityCode}
                    AND ST_DWithin(${municipalities.boundaryGeom}::geography, ${userPoint}, ${radiusMeters})
                )
            )
        )`);
    }

    const sortExpr = getReportSortExpression(query.sortBy);

    const cursorCondition = buildCursorCondition({
        cursor: query.cursor,
        sortExpr,
        idColumn: reports.id,
        sortDirection: query.sortDirection,
        valueType: query.sortBy === 'id' ? 'number' : 'date',
    });
    if (cursorCondition) {
        conditions.push(cursorCondition);
    }

    const orderBy =
        query.sortDirection === 'asc'
            ? [asc(sortExpr), asc(reports.id)]
            : [desc(sortExpr), desc(reports.id)];

    const rows = await db
        .select(reportSelect)
        .from(reports)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(...orderBy)
        .limit(query.pageSize + 1);

    return buildPaginatedResponse(
        rows,
        query.pageSize,
        (row) => extractReportSortValue(row, query.sortBy),
        toReportDto,
    );
}

function getReportSortExpression(sortBy: ReportsQuery['sortBy']): SQL {
    switch (sortBy) {
        case 'id':
            return sql`${reports.id}`;
        case 'observedAt':
            return sql`${reports.observedAt}`;
        case 'startsAt':
            return sql`COALESCE(${reports.startsAt}, ${reports.observedAt})`;
        case 'endsAt':
            return sql`COALESCE(${reports.endsAt}, ${reports.startsAt}, ${reports.observedAt})`;
    }
}

function extractReportSortValue(
    row: Omit<ReportItem, 'geom'>,
    sortBy: ReportsQuery['sortBy'],
): number | string {
    switch (sortBy) {
        case 'id':
            return row.id;
        case 'observedAt':
            return row.observedAt.toISOString();
        case 'startsAt':
            return (row.startsAt ?? row.observedAt).toISOString();
        case 'endsAt':
            return (row.endsAt ?? row.startsAt ?? row.observedAt).toISOString();
    }
}
