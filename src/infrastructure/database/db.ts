import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { config } from '../../core/config.js';
import * as schema from '../../core/schema.js';
import { logger } from '../logging/logger.js';

type Database = typeof db;
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type DbOrTx = Database | Transaction;

export const pool = new Pool({
    connectionString: config.DATABASE_URL,
});

pool.on('error', (error) => {
    logger.error('[Database] unexpected idle client error:\n%O', error);
});

export const db = drizzle(pool, { schema });
