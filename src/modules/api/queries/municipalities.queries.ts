import {
    and,
    asc,
    desc,
    eq,
    getTableColumns,
    ilike,
    or,
    type SQL,
    sql,
} from 'drizzle-orm';
import { type MunicipalityItem, municipalities } from '../../../core/schema.js';
import type { DbOrTx } from '../../../infrastructure/database/db.js';
import type { MunicipalitiesQuery } from '../validation/request/municipality.js';
import {
    type MunicipalityDto,
    toMunicipalityDto,
} from '../validation/response/municipality.js';
import { buildCursorCondition, buildPaginatedResponse } from './util/cursor.js';
import { buildContainsPattern } from './util/ilike.js';

const { centerGeom, boundaryGeom, ...baseColumns } =
    getTableColumns(municipalities);

function getMunicipalitySelect(includeBoundary: boolean) {
    return {
        ...baseColumns,
        lng: sql<number>`ST_X(${municipalities.centerGeom})`,
        lat: sql<number>`ST_Y(${municipalities.centerGeom})`,
        ...(includeBoundary
            ? {
                  boundaryJson: sql<string>`ST_AsGeoJSON(${municipalities.boundaryGeom})`,
              }
            : {}),
    };
}

export async function findMunicipalityByCode(
    db: DbOrTx,
    code: string,
    includeBoundary = true,
): Promise<MunicipalityDto | null> {
    const [row] = await db
        .select(getMunicipalitySelect(includeBoundary))
        .from(municipalities)
        .where(eq(municipalities.code, code.toUpperCase()))
        .limit(1);

    return row ? toMunicipalityDto(row) : null;
}

export async function findMunicipalities(
    db: DbOrTx,
    query: MunicipalitiesQuery,
) {
    const conditions: SQL[] = [];

    if (query.regionCode) {
        conditions.push(
            eq(municipalities.regionCode, query.regionCode.toUpperCase()),
        );
    }

    if (query.municipalityCode) {
        conditions.push(
            eq(
                municipalities.municipalityCode,
                query.municipalityCode.toUpperCase(),
            ),
        );
    }

    if (query.morphologicalType) {
        conditions.push(
            eq(municipalities.morphologicalType, query.morphologicalType),
        );
    }

    if (query.search) {
        const pattern = buildContainsPattern(query.search);
        const searchCondition = or(
            ilike(municipalities.nameMk, pattern),
            ilike(municipalities.nameEn, pattern),
            ilike(municipalities.regionNameMk, pattern),
            ilike(municipalities.regionNameEn, pattern),
            ilike(municipalities.code, pattern),
        );
        if (searchCondition) {
            conditions.push(searchCondition);
        }
    }

    if (query.lat !== undefined && query.lng !== undefined) {
        const userPoint = sql`ST_SetSRID(ST_MakePoint(${query.lng}, ${query.lat}), 4326)`;
        conditions.push(
            sql`ST_Covers(${municipalities.boundaryGeom}, ${userPoint})`,
        );
    }

    const sortColumn = municipalities[query.sortBy];

    const cursorCondition = buildCursorCondition({
        cursor: query.cursor,
        sortExpr: sortColumn,
        idColumn: municipalities.id,
        sortDirection: query.sortDirection,
        valueType: query.sortBy === 'id' ? 'number' : 'string',
    });
    if (cursorCondition) {
        conditions.push(cursorCondition);
    }

    const orderBy =
        query.sortDirection === 'asc'
            ? [asc(sortColumn), asc(municipalities.id)]
            : [desc(sortColumn), desc(municipalities.id)];

    const rows = await db
        .select(getMunicipalitySelect(query.includeBoundary))
        .from(municipalities)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(...orderBy)
        .limit(query.pageSize + 1);

    return buildPaginatedResponse(
        rows,
        query.pageSize,
        (row) => extractMunicipalitySortValue(row, query.sortBy),
        toMunicipalityDto,
    );
}

function extractMunicipalitySortValue(
    row: Omit<MunicipalityItem, 'centerGeom' | 'boundaryGeom'>,
    sortBy: MunicipalitiesQuery['sortBy'],
): number | string {
    switch (sortBy) {
        case 'id':
            return row.id;
        case 'code':
            return row.code;
        case 'nameMk':
            return row.nameMk;
        case 'nameEn':
            return row.nameEn;
    }
}
