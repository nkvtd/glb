import { Hono } from 'hono';
import type { DbOrTx } from '../../../infrastructure/database/db.js';
import {
    findMunicipalities,
    findMunicipalityByCode,
} from '../queries/municipalities.queries.js';
import {
    municipalitiesQuerySchema,
    municipalityCodeParamSchema,
    municipalityDetailQuerySchema,
} from '../validation/request/municipality.js';
import { zValidator } from '../validator.js';

export function createMunicipalitiesRouter(db: DbOrTx) {
    return new Hono()
        .get('/', zValidator('query', municipalitiesQuerySchema), async (c) => {
            const query = c.req.valid('query');
            const result = await findMunicipalities(db, query);

            return c.json(result, 200);
        })
        .get(
            '/:code',
            zValidator('param', municipalityCodeParamSchema),
            zValidator('query', municipalityDetailQuerySchema),
            async (c) => {
                const { code } = c.req.valid('param');
                const { includeBoundary } = c.req.valid('query');
                const municipality = await findMunicipalityByCode(
                    db,
                    code,
                    includeBoundary,
                );

                if (!municipality) {
                    return c.json({ message: 'Municipality not found.' }, 404);
                }

                return c.json({ data: municipality }, 200);
            },
        );
}
