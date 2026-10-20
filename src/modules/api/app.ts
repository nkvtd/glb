import { getConnInfo } from '@hono/node-server/conninfo';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import { requestId } from 'hono/request-id';
import { secureHeaders } from 'hono/secure-headers';
import { trimTrailingSlash } from 'hono/trailing-slash';
import { rateLimiter } from 'hono-rate-limiter';
import type { DbOrTx } from '../../infrastructure/database/db.js';
import { logger } from '../../infrastructure/logging/logger.js';
import { createEventsRouter } from './routes/events.router.js';
import { createMunicipalitiesRouter } from './routes/municipalities.router.js';
import { createReportsRouter } from './routes/reports.router.js';
import { createUtilRouter } from './routes/util.router.js';

export function createApp(db: DbOrTx) {
    const app = new Hono().basePath('/api');

    app.use('/*', trimTrailingSlash());
    app.use('/*', requestId({ headerName: '' }));
    app.use('/*', secureHeaders());
    app.use(
        '/*',
        cors({
            origin: '*',
            allowMethods: ['GET'],
            maxAge: 600,
        }),
    );
    app.use(
        '/*',
        rateLimiter({
            windowMs: 1 * 60 * 1000,
            limit: 60,
            keyGenerator: (c) =>
                c.req.header('cf-connecting-ip') ??
                c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
                getConnInfo(c).remote.address ??
                'unknown',
            message: { message: 'Too many requests, please try again later.' },
        }),
    );

    app.onError((err, c) => {
        if (err instanceof HTTPException) {
            return err.getResponse();
        }

        logger.error(
            `[Server:${c.get('requestId') ?? 'unknown'}] unhandled error on ${c.req.method} ${c.req.path}:\n%O`,
            err,
        );

        return c.json({ message: 'Internal server error.' }, 500);
    });

    app.notFound((c) => {
        return c.json({ message: 'Route not found.' }, 404);
    });

    return app
        .route('/', createUtilRouter(db))
        .route('/reports', createReportsRouter(db))
        .route('/events', createEventsRouter(db))
        .route('/municipalities', createMunicipalitiesRouter(db));
}
