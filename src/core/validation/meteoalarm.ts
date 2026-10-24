import { z } from 'zod';

export const meteoalarmKeyValueSchema = z.object({
    valueName: z.string(),
    value: z.string(),
});

export const meteoalarmAreaSchema = z.object({
    areaDesc: z.string(),
    geocode: z.array(meteoalarmKeyValueSchema).optional().default([]),
});

export const meteoalarmInfoSchema = z.object({
    language: z.string().optional(),
    category: z.array(z.string()).optional().default([]),
    event: z.string(),
    responseType: z.array(z.string()).optional().default([]),
    urgency: z.string().optional(),
    severity: z.string().optional(),
    certainty: z.string().optional(),
    effective: z.coerce.date().optional(),
    onset: z.coerce.date().optional(),
    expires: z.coerce.date().optional(),
    senderName: z.string().optional(),
    headline: z.string().optional(),
    description: z.string().optional(),
    web: z.string().optional(),
    contact: z.string().optional(),
    parameter: z.array(meteoalarmKeyValueSchema).optional().default([]),
    area: z.array(meteoalarmAreaSchema).min(1),
});

export const meteoalarmAlertSchema = z.object({
    identifier: z.string(),
    sender: z.string(),
    sent: z.coerce.date(),
    status: z.string(),
    msgType: z.string(),
    scope: z.string().optional(),
    incidents: z.string().optional(),
    info: z.array(meteoalarmInfoSchema).min(1),
});

export const meteoalarmWarningWrapperSchema = z.object({
    uuid: z.string(),
    alert: meteoalarmAlertSchema,
});

export const meteoalarmResponseSchema = z.object({
    warnings: z.array(meteoalarmWarningWrapperSchema),
});

export type MeteoalarmInfo = z.infer<typeof meteoalarmInfoSchema>;
export type MeteoalarmWarningWrapper = z.infer<
    typeof meteoalarmWarningWrapperSchema
>;
