import { Hono } from 'hono';
import type { DbOrTx } from '../../../infrastructure/database/db.js';
import { findReportById, findReports } from '../queries/reports.queries.js';
import { idParamSchema } from '../validation/request/id.js';
import { reportsQuerySchema } from '../validation/request/report.js';
import { zValidator } from '../validator.js';

export function createReportsRouter(db: DbOrTx) {
    return new Hono()
        .get('/', zValidator('query', reportsQuerySchema), async (c) => {
            const query = c.req.valid('query');
            const result = await findReports(db, query);

            return c.json(result, 200);
        })
        .get('/:id', zValidator('param', idParamSchema), async (c) => {
            const { id } = c.req.valid('param');
            const result = await findReportById(db, id);

            if (!result) {
                return c.json({ message: 'Report not found.' }, 404);
            }

            return c.json({ data: result }, 200);
        });
}
