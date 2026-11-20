export function capitalizeFirst(text: string): string {
    return text.charAt(0).toUpperCase() + text.slice(1);
}

export function toTitleCase(
    text: string,
    options?: { uppercaseShortWords?: boolean },
): string {
    const uppercaseShort = options?.uppercaseShortWords === true;

    return text
        .toLowerCase()
        .replace(/\p{L}+/gu, (word) =>
            uppercaseShort && word.length <= 2
                ? word.toUpperCase()
                : word.charAt(0).toUpperCase() + word.slice(1),
        );
}

export function ensurePeriod(text: string): string {
    const stripped = text.trim().replace(/\.+$/, '').trim();
    return `${stripped}.`;
}

const SENTENCE_SPLIT_RE =
    /(?<=[.!?])(?<!(?<!\p{L})(?:ул|с|бр|г|год|св|т\.н)[.!?])\s+/iu;

export function splitSentences(text: string): string[] {
    return text
        .split(SENTENCE_SPLIT_RE)
        .map((sentence) => sentence.trim())
        .filter(Boolean);
}

export function formatSummarySentences(sentences: readonly string[]): string {
    const [first = '', second] = sentences;
    const selected =
        second !== undefined &&
        `${first} ${second}`.length > 280 &&
        first.length >= 40
            ? [first]
            : sentences.slice(0, 2);

    return ensurePeriod(selected.join(' '));
}

export function formatDecimalComma(value: number, decimals: number): string {
    return value.toFixed(decimals).replace('.', ',');
}

export function formatPercentComma(value: number): string {
    return `${Number.isInteger(value) ? value : formatDecimalComma(value, 1)}%`;
}

export function decodeHtmlText(raw: string): string {
    return raw
        .replace(/<[^>]+>/g, ' ')
        .replace(/&#8211;|&ndash;/gi, '–')
        .replace(/&#8212;|&mdash;/gi, '—')
        .replace(/&nbsp;|&#160;/gi, ' ')
        .replace(/&amp;|&#038;/gi, '&')
        .replace(/&quot;|&#8220;|&#8221;|&ldquo;|&rdquo;|&#8222;/gi, '"')
        .replace(/&#8216;|&#8217;|&lsquo;|&rsquo;/gi, "'")
        .replace(/&hellip;|&#8230;/gi, '...')
        .replace(/&lt;|&#60;/gi, '<')
        .replace(/&gt;|&#62;/gi, '>')
        .replace(/\(\s+/g, '(')
        .replace(/\s+\)/g, ')')
        .replace(/\s+,/g, ',')
        .replace(/,(?!\s|\d)/g, ', ')
        .replace(/\s+/g, ' ')
        .trim();
}
