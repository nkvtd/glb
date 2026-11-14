import { z } from 'zod';

export const iodaSignalSeriesSchema = z.object({
    entityType: z.string(),
    entityCode: z.string(),
    entityName: z.string(),
    datasource: z.string(),
    from: z.number().int(),
    until: z.number().int(),
    step: z.number().int().positive(),
    values: z.array(z.number().nullable()),
});

export const iodaSignalsResponseSchema = z.object({
    error: z.string().nullable(),
    data: z.array(z.array(iodaSignalSeriesSchema)).nullable(),
});

export type IodaSignalSeries = z.infer<typeof iodaSignalSeriesSchema>;
export type IodaSignalsResponse = z.infer<typeof iodaSignalsResponseSchema>;
