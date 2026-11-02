-- Hand-written one-time backfill (data only, no schema change). Migration 0005 added
-- exercises.weighted defaulting to true, so every existing exercise became weighted — planks, runs
-- and pull-ups that never had a load now show an empty load on every set. Turn the flag off for
-- exercises that show no sign of ever carrying a load. An exercise stays weighted when ANY of:
--   - it tracks a max, or is in the 'primary' category;
--   - a program day uses it as its main lift (settings.data.program.days.*.primaryExerciseId), or
--     a strength target names it (settings.data.strengthTargets[*].exerciseId);
--   - it has a max entry;
--   - a stored workout has it in a main-lift block, or has a set of it with weight > 0 or
--     targetWeight > 0 (sessions.data.blocks[*].exercises[*].sets[*]).
-- Archived exercises are treated like any other. Only rows still weighted are touched, and
-- re-running it changes nothing more (the conditions only read data it doesn't write). The JSON
-- paths run in lax mode: a missing or oddly typed field never fails, it just doesn't match.
-- updated_at moves (the bootstrap's version stamp); the dataset_version trigger (0004) fires too.
WITH "keep" AS MATERIALIZED (
  SELECT to_jsonb("exercise_id") AS "id" FROM "max_entries"
  UNION
  SELECT jsonb_path_query("data", 'lax $.program.days.*.primaryExerciseId') FROM "settings"
  UNION
  SELECT jsonb_path_query("data", 'lax $.strengthTargets[*].exerciseId') FROM "settings"
  UNION
  SELECT jsonb_path_query(
    "data",
    'lax $.blocks[*] ? (@.kind == "primary").exercises[*].exerciseId'
  ) FROM "sessions"
  UNION
  SELECT jsonb_path_query(
    "data",
    'lax $.blocks[*].exercises[*] ? (exists(@.sets[*] ? (@.weight > 0 || @.targetWeight > 0))).exerciseId'
  ) FROM "sessions"
)
UPDATE "exercises" AS "e"
SET "weighted" = false, "updated_at" = now()
WHERE "e"."weighted"
  AND NOT "e"."tracks_max"
  AND "e"."category" <> 'primary'
  AND NOT EXISTS (SELECT 1 FROM "keep" WHERE "keep"."id" = to_jsonb("e"."id"));
