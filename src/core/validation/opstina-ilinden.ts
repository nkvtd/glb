import { z } from 'zod';

export const opstinaIlindenPostSchema = z.object({
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

export const opstinaIlindenResponseSchema = z.array(opstinaIlindenPostSchema);

export type OpstinaIlindenItem = z.infer<typeof opstinaIlindenPostSchema>;
