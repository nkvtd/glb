import { createSelectSchema } from 'drizzle-zod';
import { z } from 'zod';
import { type ReportItem, reports } from '../../../../core/schema.js';

export const reportDtoSchema = createSelectSchema(reports)
    .omit({
        geom: true,
        rawPayload: true,
        scrapedAt: true,
        updatedAt: true,
    })
    .extend({
        coordinates: z
            .object({
                lng: z.number(),
                lat: z.number(),
            })
            .nullable(),
    });

export type ReportDto = z.infer<typeof reportDtoSchema>;

export function toReportDto(
    row: ReportItem & { lng: number | null; lat: number | null },
): ReportDto {
    return reportDtoSchema.parse({
        ...row,
        coordinates:
            row.lng !== null && row.lat !== null
                ? { lng: row.lng, lat: row.lat }
                : null,
    });
}
