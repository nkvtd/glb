import { createHash } from 'node:crypto';

export function hashExternalId(...parts: Array<string | number>): string {
    return createHash('sha256')
        .update(parts.join('|'))
        .digest('hex')
        .slice(0, 32);
}
