import { z } from 'zod';

export const worldFiresHotspotSchema = z.object({
    time_utc: z.coerce.date(),
    lat: z.coerce.number(),
    lon: z.coerce.number(),
    frp_mw: z.coerce.number(),
    satellite: z.string(),
    sensor: z.string(),
});

export const worldFiresHotspotsResponseSchema = z.object({
    data: z.array(worldFiresHotspotSchema),
});

export type WorldFiresHotspot = z.infer<typeof worldFiresHotspotSchema>;
