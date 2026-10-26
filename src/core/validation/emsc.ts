import { z } from 'zod';

export const emscFeatureSchema = z.object({
    id: z.string(),
    geometry: z
        .object({
            type: z.literal('Point'),
            coordinates: z.tuple([z.number(), z.number(), z.number()]),
        })
        .nullable()
        .optional(),
    properties: z.object({
        unid: z.string(),
        source_id: z.string(),
        source_catalog: z.string(),
        lastupdate: z.coerce.date(),
        time: z.coerce.date(),
        flynn_region: z.string(),
        lat: z.coerce.number(),
        lon: z.coerce.number(),
        depth: z.coerce.number(),
        evtype: z.string().optional(),
        auth: z.string(),
        mag: z.coerce.number(),
        magtype: z.string(),
    }),
});

export const emscResponseSchema = z.object({
    features: z.array(emscFeatureSchema),
});

export type EmscFeature = z.infer<typeof emscFeatureSchema>;
