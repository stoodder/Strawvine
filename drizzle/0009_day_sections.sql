ALTER TABLE "day_logs" ADD COLUMN "zone2_machine" varchar(40);--> statement-breakpoint
ALTER TABLE "day_logs" ADD COLUMN "zone2_skipped" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "day_logs" ADD COLUMN "metcon_skipped" boolean DEFAULT false NOT NULL;