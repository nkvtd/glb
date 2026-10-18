import {
    customType,
    index,
    jsonb,
    pgEnum,
    pgTable,
    serial,
    text,
    timestamp,
    uniqueIndex,
} from 'drizzle-orm/pg-core';

export const morphologicalTypeEnum = pgEnum('morphological_type', [
    'urban',
    'rural',
]);

export const lifecycleStatusEnum = pgEnum('lifecycle_status', [
    'scheduled',
    'ongoing',
    'ended',
    'unknown',
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

export const reports = pgTable(
    'reports',
    {
        id: serial('id').primaryKey(),
        externalId: text('external_id').notNull(),
        source: text('source').notNull(),
        category: text('category').notNull(),
        title: text('title').notNull(),
        description: text('description'),
        municipalityCode: text('municipality_code'), //municipality.code
        locationLabel: text('location_label'),
        geom: pointGeometry('geom'),
        status: lifecycleStatusEnum('status').notNull(),
        rawPayload: jsonb('raw_payload'),

        observedAt: timestamp('observed_at', {
            withTimezone: true,
        }).notNull(),
        startsAt: timestamp('starts_at', {
            withTimezone: true,
        }),
        endsAt: timestamp('ends_at', {
            withTimezone: true,
        }),

        scrapedAt: timestamp('scraped_at', {
            withTimezone: true,
        })
            .defaultNow()
            .notNull(),
        updatedAt: timestamp('updated_at', {
            withTimezone: true,
        })
            .defaultNow()
            .notNull(),
    },
    (t) => [
        uniqueIndex('reports_source_external_id_idx').on(
            t.source,
            t.externalId,
        ),
        index('reports_municipality_code_idx').on(t.municipalityCode),
        index('reports_category_idx').on(t.category),
        index('reports_geom_idx').using('gist', t.geom),
        index('reports_status_idx').on(t.status),
        index('reports_starts_at_idx').on(t.startsAt),
        index('reports_ends_at_idx').on(t.endsAt),
    ],
);

export const events = pgTable(
    'events',
    {
        id: serial('id').primaryKey(),
        externalId: text('external_id').notNull(),
        source: text('source').notNull(),
        category: text('category').notNull(),
        title: text('title').notNull(),
        description: text('description'),
        status: lifecycleStatusEnum('status').notNull(),
        rawPayload: jsonb('raw_payload'),

        observedAt: timestamp('observed_at', {
            withTimezone: true,
        }).notNull(),
        startsAt: timestamp('starts_at', {
            withTimezone: true,
        }),
        endsAt: timestamp('ends_at', {
            withTimezone: true,
        }),

        scrapedAt: timestamp('scraped_at', {
            withTimezone: true,
        })
            .defaultNow()
            .notNull(),
        updatedAt: timestamp('updated_at', {
            withTimezone: true,
        })
            .defaultNow()
            .notNull(),
    },
    (t) => [
        uniqueIndex('events_source_external_id_idx').on(t.source, t.externalId),
        index('events_category_idx').on(t.category),
        index('events_status_idx').on(t.status),
        index('events_starts_at_idx').on(t.startsAt),
        index('events_ends_at_idx').on(t.endsAt),
    ],
);

export type MunicipalityItem = typeof municipalities.$inferSelect;
export type MunicipalityInsert = typeof municipalities.$inferInsert;

export type ReportItem = typeof reports.$inferSelect;
export type ReportInsert = typeof reports.$inferInsert;

export type EventItem = typeof events.$inferSelect;
export type EventInsert = typeof events.$inferInsert;
