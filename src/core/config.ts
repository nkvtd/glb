import { z } from 'zod';

const configSchema = z.object({
    PORT: z.coerce.number().default(8080),
    DATABASE_URL: z.string(),
});

export const config = configSchema.parse(process.env);
