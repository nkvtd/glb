import { z } from 'zod';

export const vodovodKumanovoItemSchema = z.object({
    id: z.number(),
    date: z.string(),
    link: z.string(),
    title: z.object({
        rendered: z.string(),
    }),
    content: z.object({
        rendered: z.string(),
    }),
});

export const vodovodKumanovoResponseSchema = z.array(vodovodKumanovoItemSchema);

export type VodovodKumanovoItem = z.infer<typeof vodovodKumanovoItemSchema>;
