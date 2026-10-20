import {
    and,
    asc,
    desc,
    eq,
    gte,
    ilike,
    inArray,
    lte,
    or,
    type SQL,
    sql,
} from 'drizzle-orm';
import { type EventItem, events } from '../../../core/schema.js';
import type { DbOrTx } from '../../../infrastructure/database/db.js';
import type { EventsQuery } from '../validation/request/event.js';
import { type EventDto, toEventDto } from '../validation/response/event.js';
import { buildCursorCondition, buildPaginatedResponse } from './util/cursor.js';
import { buildContainsPattern } from './util/ilike.js';

export async function findEventById(
    db: DbOrTx,
    id: number,
): Promise<EventDto | null> {
    const [row] = await db
        .select()
        .from(events)
        .where(eq(events.id, id))
        .limit(1);

    return row ? toEventDto(row) : null;
}

export async function findEvents(db: DbOrTx, query: EventsQuery) {
    const conditions: SQL[] = [];

    if (query.status) {
        conditions.push(inArray(events.status, query.status));
    }

    if (query.category) {
        conditions.push(inArray(events.category, query.category));
    }

    if (query.source) {
        conditions.push(eq(events.source, query.source));
    }

    if (query.search) {
        const pattern = buildContainsPattern(query.search);
        const searchCondition = or(
            ilike(events.title, pattern),
            ilike(events.description, pattern),
        );
        if (searchCondition) {
            conditions.push(searchCondition);
        }
    }

    if (query.from) {
        conditions.push(
            gte(
                sql`COALESCE(${events.startsAt}, ${events.observedAt})`,
                query.from.toISOString(),
            ),
        );
    }

    if (query.to) {
        conditions.push(
            lte(
                sql`COALESCE(${events.startsAt}, ${events.observedAt})`,
                query.to.toISOString(),
            ),
        );
    }

    const sortExpr = getEventSortExpression(query.sortBy);

    const cursorCondition = buildCursorCondition({
        cursor: query.cursor,
        sortExpr,
        idColumn: events.id,
        sortDirection: query.sortDirection,
        valueType: query.sortBy === 'id' ? 'number' : 'date',
    });
    if (cursorCondition) {
        conditions.push(cursorCondition);
    }

    const orderBy =
        query.sortDirection === 'asc'
            ? [asc(sortExpr), asc(events.id)]
            : [desc(sortExpr), desc(events.id)];

    const rows = await db
        .select()
        .from(events)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(...orderBy)
        .limit(query.pageSize + 1);

    return buildPaginatedResponse(
        rows,
        query.pageSize,
        (row) => extractEventSortValue(row, query.sortBy),
        toEventDto,
    );
}

function getEventSortExpression(sortBy: EventsQuery['sortBy']): SQL {
    switch (sortBy) {
        case 'id':
            return sql`${events.id}`;
        case 'observedAt':
            return sql`${events.observedAt}`;
        case 'startsAt':
            return sql`COALESCE(${events.startsAt}, ${events.observedAt})`;
        case 'endsAt':
            return sql`COALESCE(${events.endsAt}, ${events.startsAt}, ${events.observedAt})`;
    }
}

function extractEventSortValue(
    row: EventItem,
    sortBy: EventsQuery['sortBy'],
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
