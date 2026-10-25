import assert from 'node:assert/strict';

export function at<T>(items: readonly T[], index: number): T {
    const value = items[index];
    assert.ok(value !== undefined, `Expected an item at index ${index}`);
    return value;
}

export function present<T>(value: T | null | undefined): T {
    assert.ok(value !== null && value !== undefined);
    return value;
}
