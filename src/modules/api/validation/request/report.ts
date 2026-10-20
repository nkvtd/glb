import { z } from 'zod';
import { reportCategories } from '../../../../core/enums.js';
import { lifecycleStatusEnum } from '../../../../core/schema.js';
import { buildSortablePaginationQuerySchema } from './pagination.js';

export const reportSortFields = [
    'id',
    'observedAt',
    'startsAt',
    'endsAt',
] as const;

const commaSeparatedEnum = <T extends readonly [string, ...string[]]>(
    values: T,
) =>
    z
        .string()
        .transform((val) =>
            val
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean),
        )
        .pipe(z.array(z.enum(values)).min(1));

export const reportsQuerySchema = buildSortablePaginationQuerySchema(
    reportSortFields,
    'startsAt',
    'desc',
)
    .extend({
        status: commaSeparatedEnum(lifecycleStatusEnum.enumValues).optional(),
        category: commaSeparatedEnum(reportCategories).optional(),
        source: z.string().trim().min(1).optional(),
        municipalityCode: z.string().trim().min(1).optional(),
        search: z.string().trim().min(1).max(100).optional(),
        from: z.coerce.date().optional(),
        to: z.coerce.date().optional(),
        lat: z.coerce.number().min(-90).max(90).optional(),
        lng: z.coerce.number().min(-180).max(180).optional(),
        radius: z.coerce.number().int().min(50).max(50_000).optional(),
    })
    .refine(
        (data) =>
            (data.lat === undefined && data.lng === undefined) ||
            (data.lat !== undefined && data.lng !== undefined),
        {
            message:
                'Both lat and lng must be provided together for spatial queries',
            path: ['lat'],
        },
    );

export type ReportsQuery = z.infer<typeof reportsQuerySchema>;
