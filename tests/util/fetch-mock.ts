export async function withFetch<T>(
    mock: typeof globalThis.fetch,
    fn: () => Promise<T>,
): Promise<T> {
    const original = globalThis.fetch;
    globalThis.fetch = mock;
    try {
        return await fn();
    } finally {
        globalThis.fetch = original;
    }
}

export function jsonResponse(
    body: unknown,
    status = 200,
    headers?: Record<string, string>,
): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json', ...headers },
    });
}

export function textResponse(
    body: string,
    status = 500,
    headers?: Record<string, string>,
): Response {
    return new Response(body, {
        status,
        headers: { 'Content-Type': 'text/plain', ...headers },
    });
}

export function emptyResponse(status = 204): Response {
    return new Response(null, { status });
}
