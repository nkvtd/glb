import * as schema from '../../core/schema.js';
import type { DbOrTx } from '../../infrastructure/database/db.js';

export class MunicipalityResolver {
    private readonly db: DbOrTx;
    private readonly cache = new Map<string, string>();

    constructor(db: DbOrTx) {
        this.db = db;
    }

    async init(): Promise<void> {
        if (this.cache.size > 0) return;

        const rows = await this.db
            .select({
                code: schema.municipalities.code,
                nameMk: schema.municipalities.nameMk,
                nameEn: schema.municipalities.nameEn,
            })
            .from(schema.municipalities);

        const entries: Array<[string, string]> = [];

        for (const row of rows) {
            entries.push([this.normalize(row.nameMk), row.code]);
            entries.push([this.normalize(row.nameEn), row.code]);
        }

        entries.sort((a, b) => b[0].length - a[0].length);

        for (const [name, code] of entries) {
            this.cache.set(name, code);
        }
    }

    resolve(rawText?: string | null): string | null {
        if (!rawText) return null;

        const normalized = this.normalize(rawText);
        if (!normalized) return null;

        const exact = this.cache.get(normalized);
        if (exact) return exact;

        for (const segment of normalized.split('-')) {
            const match = this.cache.get(segment);
            if (match) return match;
        }

        for (const [name, code] of this.cache.entries()) {
            if (normalized.includes(name)) return code;
        }

        return null;
    }

    private normalize(text: string): string {
        return text
            .toUpperCase()
            .replace(/\s*-\s*/g, '-')
            .replace(/\s+/g, ' ')
            .trim();
    }
}
