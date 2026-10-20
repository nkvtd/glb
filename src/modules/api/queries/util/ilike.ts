function escapeLikePattern(input: string): string {
    return input
        .replace(/\\/g, '\\\\')
        .replace(/%/g, '\\%')
        .replace(/_/g, '\\_');
}

export function buildContainsPattern(input: string): string {
    return `%${escapeLikePattern(input)}%`;
}
