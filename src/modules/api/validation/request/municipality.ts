import { z } from 'zod';
import { morphologicalTypeEnum } from '../../../../core/schema.js';
import { buildSortablePaginationQuerySchema } from './pagination.js';

export const municipalitySortFields = [
    'id',
    'code',
    'nameMk',
    'nameEn',
] as const;

export const municipalityCodeParamSchema = z.object({
    code: z.string().trim().min(1),
});

export const municipalityDetailQuerySchema = z.object({
    includeBoundary: z
        .enum(['true', 'false'])
        .optional()
        .default('true')
        .transform((val) => val === 'true'),
});

export const municipalitiesQuerySchema = buildSortablePaginationQuerySchema(
    municipalitySortFields,
    'nameMk',
    'asc',
)
    .extend({
        pageSize: z.coerce
            .number()
            .int()
            .min(1)
            .max(100)
            .optional()
            .default(100),
        regionCode: z.string().trim().min(1).optional(),
        municipalityCode: z.string().trim().min(1).optional(),
        morphologicalType: z.enum(morphologicalTypeEnum.enumValues).optional(),
        search: z.string().trim().min(1).max(100).optional(),
        lat: z.coerce.number().min(-90).max(90).optional(),
        lng: z.coerce.number().min(-180).max(180).optional(),
        includeBoundary: z
            .enum(['true', 'false'])
            .optional()
            .default('false')
            .transform((val) => val === 'true'),
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

export type MunicipalitiesQuery = z.infer<typeof municipalitiesQuerySchema>;
