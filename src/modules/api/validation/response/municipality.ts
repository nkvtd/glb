import { createSelectSchema } from 'drizzle-zod';
import { z } from 'zod';
import {
    type MunicipalityItem,
    municipalities,
} from '../../../../core/schema.js';

const multiPolygonSchema = z.object({
    type: z.literal('MultiPolygon'),
    coordinates: z.array(z.array(z.array(z.tuple([z.number(), z.number()])))),
});

export const municipalityDtoSchema = createSelectSchema(municipalities)
    .omit({
        centerGeom: true,
        boundaryGeom: true,
    })
    .extend({
        center: z.object({
            lng: z.number(),
            lat: z.number(),
        }),
        boundary: multiPolygonSchema.optional(),
    });

export type MunicipalityDto = z.infer<typeof municipalityDtoSchema>;

export function toMunicipalityDto(
    row: Omit<MunicipalityItem, 'centerGeom' | 'boundaryGeom'> & {
        lng: number;
        lat: number;
        boundaryJson?: string | null;
    },
): MunicipalityDto {
    return municipalityDtoSchema.parse({
        ...row,
        center: {
            lng: row.lng,
            lat: row.lat,
        },
        boundary: row.boundaryJson ? JSON.parse(row.boundaryJson) : undefined,
    });
}
