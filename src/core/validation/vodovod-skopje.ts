import { z } from 'zod';

const nullableEsriDate = z
    .number()
    .nullable()
    .optional()
    .transform((val) => (val ? new Date(val) : null));

export const vodovodSkopjeFeatureSchema = z.object({
    attributes: z.object({
        idINT: z.number(),
        archiveNumber: z.string().nullable().optional(),
        Opstina: z.string(),
        Ulica: z.string(),
        adresaBrojDefekt: z.string().nullable().optional(),
        lokacija: z.string().nullable().optional(),
        vidDefektId: z.number().nullable().optional(),
        vidDefektName: z.string(),
        vidIntervencijaId: z.number().nullable().optional(),
        vidIntervencijaName: z.string().nullable().optional(),
        defectInfo: z.string().nullable().optional(),
        itnostString: z.string().nullable().optional(),
        izvesteniPrekin: z.string().nullable().optional(),
        status: z.number(),
        statusVreme: nullableEsriDate,
        acceptanceDate: z.number().transform((val) => new Date(val)),
        datumZatvorenaVoda: nullableEsriDate,
        datumPustenaVoda: nullableEsriDate,
        zatvorenaVodaTip: z.number().nullable().optional(),
        prekinStrujaHidrofor: z.number().nullable().optional(),
        naprevenUvid: z.number().nullable().optional(),
        title: z.string().nullable().optional(),
    }),
    geometry: z
        .object({
            x: z.number(),
            y: z.number(),
        })
        .nullable()
        .optional(),
});

export const vodovodSkopjeResponseSchema = z.object({
    features: z.array(vodovodSkopjeFeatureSchema),
});

export type vodovodSkopjeFeature = z.infer<typeof vodovodSkopjeFeatureSchema>;
