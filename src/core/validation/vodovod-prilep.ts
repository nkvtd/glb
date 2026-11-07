import { z } from 'zod';

export const vodovodPrilepItemSchema = z.object({
    id: z.number(),
    date: z.string(),
    link: z.string(),
    title: z.object({
        rendered: z.string(),
    }),
    excerpt: z
        .object({
            rendered: z.string(),
        })
        .optional(),
    content: z.object({
        rendered: z.string(),
    }),
});

export const vodovodPrilepResponseSchema = z.array(vodovodPrilepItemSchema);

export type VodovodPrilepItem = z.infer<typeof vodovodPrilepItemSchema>;
