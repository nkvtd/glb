import { Hono } from 'hono';
import type { DbOrTx } from '../../../infrastructure/database/db.js';
import { findEventById, findEvents } from '../queries/events.queries.js';
import { eventsQuerySchema } from '../validation/request/event.js';
import { idParamSchema } from '../validation/request/id.js';
import { zValidator } from '../validator.js';

export function createEventsRouter(db: DbOrTx) {
    return new Hono()
        .get('/', zValidator('query', eventsQuerySchema), async (c) => {
            const query = c.req.valid('query');
            const result = await findEvents(db, query);

            return c.json(result, 200);
        })
        .get('/:id', zValidator('param', idParamSchema), async (c) => {
            const { id } = c.req.valid('param');
            const result = await findEventById(db, id);

            if (!result) {
                return c.json({ message: 'Event not found.' }, 404);
            }

            return c.json({ data: result }, 200);
        });
}
