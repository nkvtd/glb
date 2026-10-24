import 'dotenv/config';
import { z } from 'zod';

const configSchema = z.object({
    PORT: z.coerce.number().default(8080),
    DATABASE_URL: z.string(),
    DISCORD_WEBHOOK_URLS: z.preprocess(
        (val) =>
            typeof val === 'string'
                ? val
                      .split(',')
                      .map((s) => s.trim())
                      .filter(Boolean)
                : [],
        z.array(z.url()),
    ),
});

export const config = configSchema.parse(process.env);
