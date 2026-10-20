import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import type { DbOrTx } from '../../../infrastructure/database/db.js';

export function createUtilRouter(db: DbOrTx) {
    return new Hono()
        .get('/ping', (c) => {
            return c.json({ message: 'pong' }, 200);
        })
        .get('/ready', async (c) => {
            try {
                await db.execute(sql`select 1`);

                return c.json({ message: 'Ready.' }, 200);
            } catch {
                return c.json({ message: 'Not ready.' }, 503);
            }
        });
}
