import { z } from 'zod';

export const evnItemSchema = z.object({
    prekinID: z.string(),
    kecId: z.number(),
    tipPrekin: z.string(),
    nasMesto: z.string(),
    adresa: z.string(),
    pocetok: z.coerce.date(),
    kraj: z.coerce.date(),
    napNivo: z.string(),
});

export const evnResponseSchema = z.array(evnItemSchema);

export type EvnItem = z.infer<typeof evnItemSchema>;
