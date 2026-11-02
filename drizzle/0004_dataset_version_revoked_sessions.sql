CREATE TABLE "dataset_version" (
	"id" integer PRIMARY KEY NOT NULL,
	"v" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "revoked_sessions" (
	"token_hash" varchar(64) PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
-- Hand-written below: the counter row and the triggers that bump it (drizzle doesn't model triggers).
-- Every transaction that changes a data table bumps the counter exactly once, in that transaction
-- (the transaction-local setting remembers it already did), so a write's version is exact and
-- commits atomically with the write — whichever process or release made it.
INSERT INTO "dataset_version" ("id", "v") VALUES (1, 1) ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "bump_dataset_version"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF coalesce(current_setting('strawvine.dataset_bumped', true), '') <> 'on' THEN
    PERFORM set_config('strawvine.dataset_bumped', 'on', true);
    INSERT INTO "dataset_version" ("id", "v") VALUES (1, 1)
      ON CONFLICT ("id") DO UPDATE SET "v" = "dataset_version"."v" + 1;
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "day_logs_dataset_version" AFTER INSERT OR UPDATE OR DELETE ON "day_logs" FOR EACH ROW EXECUTE FUNCTION "bump_dataset_version"();
--> statement-breakpoint
CREATE TRIGGER "day_logs_dataset_version_truncate" AFTER TRUNCATE ON "day_logs" FOR EACH STATEMENT EXECUTE FUNCTION "bump_dataset_version"();
--> statement-breakpoint
CREATE TRIGGER "sessions_dataset_version" AFTER INSERT OR UPDATE OR DELETE ON "sessions" FOR EACH ROW EXECUTE FUNCTION "bump_dataset_version"();
--> statement-breakpoint
CREATE TRIGGER "sessions_dataset_version_truncate" AFTER TRUNCATE ON "sessions" FOR EACH STATEMENT EXECUTE FUNCTION "bump_dataset_version"();
--> statement-breakpoint
CREATE TRIGGER "exercises_dataset_version" AFTER INSERT OR UPDATE OR DELETE ON "exercises" FOR EACH ROW EXECUTE FUNCTION "bump_dataset_version"();
--> statement-breakpoint
CREATE TRIGGER "exercises_dataset_version_truncate" AFTER TRUNCATE ON "exercises" FOR EACH STATEMENT EXECUTE FUNCTION "bump_dataset_version"();
--> statement-breakpoint
CREATE TRIGGER "max_entries_dataset_version" AFTER INSERT OR UPDATE OR DELETE ON "max_entries" FOR EACH ROW EXECUTE FUNCTION "bump_dataset_version"();
--> statement-breakpoint
CREATE TRIGGER "max_entries_dataset_version_truncate" AFTER TRUNCATE ON "max_entries" FOR EACH STATEMENT EXECUTE FUNCTION "bump_dataset_version"();
--> statement-breakpoint
CREATE TRIGGER "settings_dataset_version" AFTER INSERT OR UPDATE OR DELETE ON "settings" FOR EACH ROW EXECUTE FUNCTION "bump_dataset_version"();
--> statement-breakpoint
CREATE TRIGGER "settings_dataset_version_truncate" AFTER TRUNCATE ON "settings" FOR EACH STATEMENT EXECUTE FUNCTION "bump_dataset_version"();
--> statement-breakpoint
CREATE TRIGGER "seen_achievements_dataset_version" AFTER INSERT OR UPDATE OR DELETE ON "seen_achievements" FOR EACH ROW EXECUTE FUNCTION "bump_dataset_version"();
--> statement-breakpoint
CREATE TRIGGER "seen_achievements_dataset_version_truncate" AFTER TRUNCATE ON "seen_achievements" FOR EACH STATEMENT EXECUTE FUNCTION "bump_dataset_version"();
