import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { logger } from '../logging/logger.js';
import { db, pool } from './db.js';

type AdministrativeType = 'urban' | 'rural';

type GeoJsonFeature = {
    type: 'Feature';
    properties: {
        ADM1_MK: string;
        ADM1_EN: string;
        ADM1_PCODE: string;
        ADM2_MK: string;
        ADM2_EN: string;
        ADM2_PCODE: string;
        ADM2_TYPE: AdministrativeType;
        PCODEX: string;
    };
    geometry: {
        type: 'Polygon' | 'MultiPolygon';
        coordinates: unknown;
    };
};

type GeoJsonFeatureCollection = {
    type: 'FeatureCollection';
    features: GeoJsonFeature[];
};

const filePath = path.resolve(
    process.cwd(),
    'data/mkd_admbnda_adm2_2025_AB.geojson',
);

async function seed() {
    const raw = await readFile(filePath, 'utf8');
    const geojson = JSON.parse(raw) as GeoJsonFeatureCollection;

    if (geojson.type !== 'FeatureCollection') {
        throw new Error('Expected a GeoJSON FeatureCollection');
    }

    await db.transaction(async (tx) => {
        for (const feature of geojson.features) {
            const p = feature.properties;

            if (!p.PCODEX || !p.ADM2_PCODE) {
                throw new Error('Municipality is missing PCODEX or ADM2_PCODE');
            }

            const geometryJson = JSON.stringify(feature.geometry);

            await tx.execute(sql`
                INSERT INTO municipalities (
                    code,
                    municipality_code,
                    name_mk,
                    name_en,
                    region_code,
                    region_name_mk,
                    region_name_en,
                    morphological_type,
                    center_geom,
                    boundary_geom
                )
                VALUES (
                    ${p.PCODEX},
                    ${p.ADM2_PCODE},
                    ${p.ADM2_MK.trim()},
                    ${p.ADM2_EN.trim()},
                    ${p.ADM1_PCODE},
                    ${p.ADM1_MK.trim()},
                    ${p.ADM1_EN.trim()},
                    ${p.ADM2_TYPE},
                    ST_PointOnSurface(
                        ST_Multi(
                            ST_SetSRID(
                                ST_GeomFromGeoJSON(${geometryJson}),
                                4326
                            )
                        )
                    ),
                    ST_Multi(
                        ST_SetSRID(
                            ST_GeomFromGeoJSON(${geometryJson}),
                            4326
                        )
                    )
                )
                ON CONFLICT (code) DO UPDATE SET
                    municipality_code = EXCLUDED.municipality_code,
                    name_mk = EXCLUDED.name_mk,
                    name_en = EXCLUDED.name_en,
                    region_code = EXCLUDED.region_code,
                    region_name_mk = EXCLUDED.region_name_mk,
                    region_name_en = EXCLUDED.region_name_en,
                    morphological_type = EXCLUDED.morphological_type,
                    center_geom = EXCLUDED.center_geom,
                    boundary_geom = EXCLUDED.boundary_geom;
            `);
        }
    });

    logger.info(`Seeded data successfully.`);
}

try {
    await seed();
} catch (error) {
    logger.error('Data seeding failed:', error);
    process.exitCode = 1;
} finally {
    await pool.end();
    logger.close();
}
