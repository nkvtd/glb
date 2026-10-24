import { z } from 'zod';

export const sensorCommunityDataValueSchema = z.object({
    id: z.number().optional(),
    value_type: z.string(),
    value: z.union([z.string(), z.number()]).transform((val) => Number(val)),
});

export const sensorCommunitySensorSchema = z.object({
    id: z.number(),
    pin: z.string().optional(),
    sensor_type: z.object({
        id: z.number(),
        name: z.string(),
        manufacturer: z.string(),
    }),
});

export const sensorCommunityLocationSchema = z.object({
    id: z.number(),
    latitude: z.union([z.string(), z.number()]).transform((val) => Number(val)),
    longitude: z
        .union([z.string(), z.number()])
        .transform((val) => Number(val)),
    altitude: z
        .union([z.string(), z.number()])
        .nullable()
        .optional()
        .transform((val) =>
            val !== null && val !== undefined ? Number(val) : null,
        ),
    country: z.string(),
    indoor: z.number(),
    exact_location: z.number().optional(),
});

export const sensorCommunityItemSchema = z.object({
    id: z.number(),
    timestamp: z.string(),
    sampling_rate: z.unknown().nullable().optional(),
    sensor: sensorCommunitySensorSchema,
    location: sensorCommunityLocationSchema,
    sensordatavalues: z.array(sensorCommunityDataValueSchema),
});

export const sensorCommunityResponseSchema = z.array(sensorCommunityItemSchema);

export type SensorCommunityItem = z.infer<typeof sensorCommunityItemSchema>;
