CREATE EXTENSION IF NOT EXISTS postgis;--> statement-breakpoint
CREATE TYPE "public"."morphological_type" AS ENUM('urban', 'rural');--> statement-breakpoint
CREATE TABLE "municipalities" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"municipality_code" text NOT NULL,
	"name_mk" text NOT NULL,
	"name_en" text NOT NULL,
	"region_code" text NOT NULL,
	"region_name_mk" text NOT NULL,
	"region_name_en" text NOT NULL,
	"morphological_type" "morphological_type" NOT NULL,
	"center_geom" geometry(Point, 4326) NOT NULL,
	"boundary_geom" geometry(MultiPolygon, 4326) NOT NULL,
	CONSTRAINT "municipalities_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE INDEX "idx_municipalities_adm2" ON "municipalities" USING btree ("municipality_code");--> statement-breakpoint
CREATE INDEX "idx_municipalities_region" ON "municipalities" USING btree ("region_code");--> statement-breakpoint
CREATE INDEX "idx_municipalities_boundary" ON "municipalities" USING gist ("boundary_geom");--> statement-breakpoint
CREATE INDEX "idx_municipalities_center" ON "municipalities" USING gist ("center_geom");