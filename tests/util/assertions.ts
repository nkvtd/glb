import assert from 'node:assert/strict';
import type { SQL, SQLWrapper } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

export function at<T>(items: readonly T[], index: number): T {
    const value = items[index];
    assert.ok(value !== undefined, `Expected an item at index ${index}`);
    return value;
}

export function present<T>(value: T | null | undefined): T {
    assert.ok(value !== null && value !== undefined);
    return value;
}

export function sqlText(fragment: SQL | SQLWrapper): string {
    return new PgDialect().sqlToQuery(fragment.getSQL()).sql;
}

export function sqlParams(fragment: SQL | SQLWrapper): unknown[] {
    return new PgDialect().sqlToQuery(fragment.getSQL()).params;
}
