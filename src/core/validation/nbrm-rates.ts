import { z } from 'zod';

export const nbrmRateItemSchema = z.object({
    rBr: z.number().int().positive(),
    datum: z.string(),
    valuta: z.string(),
    oznaka: z.string().min(1),
    drzava: z.string(),
    nomin: z.number().int().positive(),
    sreden: z.number().positive(),
    nazivMak: z.string(),
    datum_f: z.string(),
});

export const nbrmRatesResponseSchema = z.array(nbrmRateItemSchema);

export type NbrmRateItem = z.infer<typeof nbrmRateItemSchema>;
