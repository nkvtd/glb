import { z } from 'zod';

const cursorPayloadSchema = z.object({
    v: z.union([z.number(), z.string()]),
    id: z.number().int().positive(),
});

export type CursorPayload = z.infer<typeof cursorPayloadSchema>;

export function encodeCursor(payload: CursorPayload): string {
    return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): CursorPayload | null {
    try {
        const json = JSON.parse(
            Buffer.from(cursor, 'base64url').toString('utf8'),
        );
        const parsed = cursorPayloadSchema.safeParse(json);
        return parsed.success ? parsed.data : null;
    } catch {
        return null;
    }
}

export const paginationQuerySchema = z.object({
    cursor: z
        .string()
        .trim()
        .min(1)
        .refine((val) => decodeCursor(val) !== null, {
            message: 'Invalid pagination cursor',
        })
        .optional(),
    pageSize: z.coerce.number().int().min(1).max(100).optional().default(20),
});

export function buildSortablePaginationQuerySchema<
    const TSortFields extends readonly [string, ...string[]],
>(
    sortFields: TSortFields,
    defaultSortBy: TSortFields[number],
    defaultSortDirection: 'asc' | 'desc' = 'desc',
) {
    return paginationQuerySchema.extend({
        sortBy: z.enum(sortFields).optional().default(defaultSortBy),
        sortDirection: z
            .enum(['asc', 'desc'])
            .optional()
            .default(defaultSortDirection),
    });
}
