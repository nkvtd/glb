import { z } from 'zod';

export const opstinaDebrcaPostSchema = z.object({
    id: z.number(),
    date: z.string(),
    date_gmt: z.string(),
    link: z.string(),
    title: z.object({
        rendered: z.string(),
    }),
    content: z.object({
        rendered: z.string(),
    }),
});

export const opstinaDebrcaResponseSchema = z.array(opstinaDebrcaPostSchema);

export type OpstinaDebrcaItem = z.infer<typeof opstinaDebrcaPostSchema>;
