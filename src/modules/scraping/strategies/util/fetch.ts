import type { z } from 'zod';

export const BROWSER_JSON_HEADERS: Readonly<Record<string, string>> = {
    Accept: 'application/json',
    'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
};

export type FetchJsonOptions = {
    timeoutMs?: number;
    method?: 'GET' | 'POST';
    headers?: Record<string, string>;
    body?: string;
    rejectHtml?: boolean;
};

function buildRequestInit(options: FetchJsonOptions | undefined): RequestInit {
    const init: RequestInit = {
        signal: AbortSignal.timeout(options?.timeoutMs ?? 15_000),
    };
    if (options?.method !== undefined) {
        init.method = options.method;
    }
    if (options?.headers !== undefined) {
        init.headers = options.headers;
    }
    if (options?.body !== undefined) {
        init.body = options.body;
    }
    return init;
}

async function parseOkJson<T>(
    response: Response,
    schema: z.ZodType<T>,
    rejectHtml: boolean,
): Promise<T> {
    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
            `Fetch failed with status code ${response.status}: ${errorText}`,
        );
    }

    if (
        rejectHtml &&
        response.headers
            .get('content-type')
            ?.toLowerCase()
            .includes('text/html')
    ) {
        const errorText = await response.text();
        throw new Error(`Fetch returned an HTML error page: ${errorText}`);
    }

    return schema.parse(await response.json());
}

export async function fetchJson<T>(
    url: string | URL,
    schema: z.ZodType<T>,
    options?: FetchJsonOptions,
): Promise<T> {
    const response = await fetch(url, buildRequestInit(options));
    return parseOkJson(response, schema, options?.rejectHtml === true);
}

export async function fetchJsonOrNull<T>(
    url: string | URL,
    schema: z.ZodType<T>,
    options?: FetchJsonOptions,
): Promise<T | null> {
    const response = await fetch(url, buildRequestInit(options));
    if (response.status === 204) {
        return null;
    }
    return parseOkJson(response, schema, options?.rejectHtml === true);
}
