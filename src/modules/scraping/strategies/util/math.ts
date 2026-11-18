export function mean(values: number[]): number | null {
    if (values.length === 0) return null;
    let sum = 0;
    for (const value of values) {
        sum += value;
    }
    return sum / values.length;
}

export function trimmedMean(values: number[], trimRatio = 0.2): number | null {
    if (values.length === 0) return null;
    if (values.length < 4) return mean(values);

    const sorted = [...values].sort((a, b) => a - b);
    const trimCount = Math.max(1, Math.floor(sorted.length * trimRatio));

    return mean(sorted.slice(trimCount, sorted.length - trimCount));
}

export function median(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    const value =
        sorted.length % 2
            ? (sorted[middle] ?? 0)
            : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
    return Number(value.toFixed(1));
}
