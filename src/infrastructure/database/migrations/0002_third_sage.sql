ALTER TABLE "reports" ADD COLUMN "geom" geometry(Point, 4326);--> statement-breakpoint
CREATE INDEX "reports_geom_idx" ON "reports" USING gist ("geom");