import {
    customType,
    index,
    pgEnum,
    pgTable,
    serial,
    text,
} from 'drizzle-orm/pg-core';

export const morphologicalTypeEnum = pgEnum('morphological_type', [
    'urban',
    'rural',
]);

const pointGeometry = customType<{ data: string }>({
    dataType: () => 'geometry(Point, 4326)',
});

const multiPolygonGeometry = customType<{ data: string }>({
    dataType: () => 'geometry(MultiPolygon, 4326)',
});

export const municipalities = pgTable(
    'municipalities',
    {
        id: serial('id').primaryKey(),
        code: text('code').notNull().unique(), // PCODEX
        municipalityCode: text('municipality_code').notNull(), // ADM2_PCODE
        nameMk: text('name_mk').notNull(), // ADM2_MK
        nameEn: text('name_en').notNull(), // ADM2_EN
        regionCode: text('region_code').notNull(), // ADM1_PCODE
        regionNameMk: text('region_name_mk').notNull(), // ADM1_MK
        regionNameEn: text('region_name_en').notNull(), // ADM1_EN
        morphologicalType:
            morphologicalTypeEnum('morphological_type').notNull(), // ADM2_TYPE
        centerGeom: pointGeometry('center_geom').notNull(),
        boundaryGeom: multiPolygonGeometry('boundary_geom').notNull(),
    },
    (t) => [
        index('idx_municipalities_adm2').on(t.municipalityCode),
        index('idx_municipalities_region').on(t.regionCode),
        index('idx_municipalities_boundary').using('gist', t.boundaryGeom),
        index('idx_municipalities_center').using('gist', t.centerGeom),
    ],
);
