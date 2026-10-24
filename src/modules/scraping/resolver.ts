import { sql } from 'drizzle-orm';
import * as schema from '../../core/schema.js';
import type { DbOrTx } from '../../infrastructure/database/db.js';

export class MunicipalityResolver {
    private readonly db: DbOrTx;
    private readonly textCache = new Map<string, string>();
    private readonly coordsCache = new Map<string, string | null>();
    private readonly regionCache = new Map<
        string,
        Array<{ code: string; nameMk: string }>
    >();

    constructor(db: DbOrTx) {
        this.db = db;
    }

    async init(): Promise<void> {
        if (this.textCache.size > 0) return;

        const rows = await this.db
            .select({
                code: schema.municipalities.code,
                nameMk: schema.municipalities.nameMk,
                nameEn: schema.municipalities.nameEn,
                regionCode: schema.municipalities.regionCode,
            })
            .from(schema.municipalities);

        const entries: Array<[string, string]> = [];
        const seenInRegion = new Set<string>();

        for (const row of rows) {
            entries.push([this.normalize(row.nameMk), row.code]);
            entries.push([this.normalize(row.nameEn), row.code]);

            const regionKey = row.regionCode.trim().toUpperCase();
            const dedupeKey = `${regionKey}:${this.normalize(row.nameMk)}`;

            if (!seenInRegion.has(dedupeKey)) {
                seenInRegion.add(dedupeKey);
                const list = this.regionCache.get(regionKey) ?? [];
                list.push({ code: row.code, nameMk: row.nameMk });
                this.regionCache.set(regionKey, list);
            }
        }

        entries.sort((a, b) => b[0].length - a[0].length);

        for (const [name, code] of entries) {
            this.textCache.set(name, code);
        }
    }

    resolveText(rawText?: string | null): string | null {
        if (!rawText) return null;

        const normalized = this.normalize(rawText);
        if (!normalized) return null;

        const exact = this.textCache.get(normalized);
        if (exact) return exact;

        for (const segment of normalized.split('-')) {
            const match = this.textCache.get(segment);
            if (match) return match;
        }

        for (const [name, code] of this.textCache.entries()) {
            if (normalized.includes(name)) return code;
        }

        return null;
    }

    async resolveCoords(
        lng?: number | null,
        lat?: number | null,
    ): Promise<string | null> {
        if (
            lng === undefined ||
            lng === null ||
            lat === undefined ||
            lat === null ||
            !Number.isFinite(lng) ||
            !Number.isFinite(lat)
        ) {
            return null;
        }

        const key = `${lng},${lat}`;
        if (this.coordsCache.has(key)) {
            return this.coordsCache.get(key) ?? null;
        }

        const point = sql`ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)`;
        const [row] = await this.db
            .select({ code: schema.municipalities.code })
            .from(schema.municipalities)
            .where(
                sql`ST_Covers(${schema.municipalities.boundaryGeom}, ${point})`,
            )
            .limit(1);

        const code = row?.code ?? null;
        this.coordsCache.set(key, code);

        return code;
    }

    resolveRegion(
        regionCode?: string | null,
    ): Array<{ code: string; nameMk: string }> {
        if (!regionCode) return [];
        return this.regionCache.get(regionCode.trim().toUpperCase()) ?? [];
    }

    private normalize(text: string): string {
        return text
            .toUpperCase()
            .replace(/\s*-\s*/g, '-')
            .replace(/\s+/g, ' ')
            .trim();
    }
}
