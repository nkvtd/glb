import { z } from 'zod';
import { eventCategories } from '../../../../core/enums.js';
import { lifecycleStatusEnum } from '../../../../core/schema.js';
import { buildSortablePaginationQuerySchema } from './pagination.js';

export const eventSortFields = [
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

export const eventsQuerySchema = buildSortablePaginationQuerySchema(
    eventSortFields,
    'startsAt',
    'desc',
).extend({
    status: commaSeparatedEnum(lifecycleStatusEnum.enumValues).optional(),
    category: commaSeparatedEnum(eventCategories).optional(),
    source: z.string().trim().min(1).optional(),
    search: z.string().trim().min(1).max(100).optional(),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
});

export type EventsQuery = z.infer<typeof eventsQuerySchema>;
