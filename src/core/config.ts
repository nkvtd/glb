import 'dotenv/config';
import { z } from 'zod';

const configSchema = z.object({
    PORT: z.coerce.number().default(8080),
    DATABASE_URL: z.string(),
    DISCORD_WEBHOOK_URL: z.url().optional(),
});

export const config = configSchema.parse(process.env);
