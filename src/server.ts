import { serve } from '@hono/node-server';
import { config } from './core/config.js';
import { db, pool } from './infrastructure/database/db.js';
import { logger } from './infrastructure/logging/logger.js';
import { createApp } from './modules/api/app.js';

async function main() {
    logger.info('[Server] starting...');

    const app = createApp(db);

    const server = serve(
        {
            fetch: app.fetch,
            port: config.PORT,
        },
        (info) => {
            logger.info(`[Server] started and running on port ${info.port}.`);
        },
    );

    server.on('error', (error: NodeJS.ErrnoException) => {
        logger.error('[Server] failed to start:\n%O', error);
        process.exit(1);
    });

    const shutdown = () => {
        logger.info('[Server] shutting down...');

        server.close(async (err) => {
            if (err) {
                logger.error('[Server] error during shutdown:\n%O', err);
                process.exit(1);
            }

            await pool.end();
            logger.close();
            process.exit(0);
        });
    };

    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
}

main().catch((error) => {
    logger.error('[Server] failed to start:\n%O', error);
    process.exit(1);
});
