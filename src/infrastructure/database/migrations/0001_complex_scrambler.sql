CREATE TYPE "public"."lifecycle_status" AS ENUM('scheduled', 'ongoing', 'ended', 'unknown');--> statement-breakpoint
CREATE TABLE "events" (
	"id" serial PRIMARY KEY NOT NULL,
	"external_id" text NOT NULL,
	"source" text NOT NULL,
	"category" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"status" "lifecycle_status" NOT NULL,
	"raw_payload" jsonb,
	"observed_at" timestamp with time zone NOT NULL,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"scraped_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"id" serial PRIMARY KEY NOT NULL,
	"external_id" text NOT NULL,
	"source" text NOT NULL,
	"category" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"municipality_code" text,
	"location_label" text,
	"status" "lifecycle_status" NOT NULL,
	"raw_payload" jsonb,
	"observed_at" timestamp with time zone NOT NULL,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"scraped_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "events_source_external_id_idx" ON "events" USING btree ("source","external_id");--> statement-breakpoint
CREATE INDEX "events_category_idx" ON "events" USING btree ("category");--> statement-breakpoint
CREATE INDEX "events_status_idx" ON "events" USING btree ("status");--> statement-breakpoint
CREATE INDEX "events_starts_at_idx" ON "events" USING btree ("starts_at");--> statement-breakpoint
CREATE INDEX "events_ends_at_idx" ON "events" USING btree ("ends_at");--> statement-breakpoint
CREATE UNIQUE INDEX "reports_source_external_id_idx" ON "reports" USING btree ("source","external_id");--> statement-breakpoint
CREATE INDEX "reports_municipality_code_idx" ON "reports" USING btree ("municipality_code");--> statement-breakpoint
CREATE INDEX "reports_category_idx" ON "reports" USING btree ("category");--> statement-breakpoint
CREATE INDEX "reports_status_idx" ON "reports" USING btree ("status");--> statement-breakpoint
CREATE INDEX "reports_starts_at_idx" ON "reports" USING btree ("starts_at");--> statement-breakpoint
CREATE INDEX "reports_ends_at_idx" ON "reports" USING btree ("ends_at");