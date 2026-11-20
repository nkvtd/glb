import { z } from 'zod';

export const opstinaOhridPostSchema = z.object({
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

export const opstinaOhridResponseSchema = z.array(opstinaOhridPostSchema);

export type OpstinaOhridItem = z.infer<typeof opstinaOhridPostSchema>;
