import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { config } from '../../core/config.js';
import * as schema from '../../core/schema.js';

const pool = new Pool({
    connectionString: config.DATABASE_URL,
});

export const db = drizzle(pool, { schema });
