import { z } from 'zod';

export const amsmFuelAcfSchema = z.object({
    gas_uid: z.string(),
    gas_country: z.string(),
    gas_currency: z.string(),
    petrol95: z.coerce.number().positive(),
    petrol98: z.coerce.number().positive(),
    diesel: z.coerce.number().positive(),
    petrol95eur: z.coerce.number().positive(),
    petrol98eur: z.coerce.number().positive(),
    dieseleur: z.coerce.number().positive(),
    gas_last_update: z.string(),
});

export const amsmFuelItemSchema = z.object({
    id: z.number(),
    date: z.string(),
    date_gmt: z.string(),
    modified: z.string(),
    modified_gmt: z.string(),
    slug: z.string(),
    status: z.string(),
    type: z.string(),
    link: z.string(),
    title: z.object({
        rendered: z.string(),
    }),
    acf: amsmFuelAcfSchema,
});

export const amsmFuelResponseSchema = z.array(amsmFuelItemSchema);

export type AmsmFuelAcf = z.infer<typeof amsmFuelAcfSchema>;
export type AmsmFuelItem = z.infer<typeof amsmFuelItemSchema>;
