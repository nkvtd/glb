import { z } from 'zod';

export const opstinaVelesPostSchema = z.object({
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

export const opstinaVelesResponseSchema = z.array(opstinaVelesPostSchema);

export type OpstinaVelesItem = z.infer<typeof opstinaVelesPostSchema>;
