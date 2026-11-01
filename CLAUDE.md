# Strawvine — notes for Claude

- Product spec: `docs/SPEC.md` (source of truth for formulas and behaviour). The athlete's program is *example data*:
  every training rule must stay configurable via `Settings`, never hard-coded.
- Domain logic is pure and lives in `src/shared` (tested with vitest). UI and API must not reimplement formulas.
- Nothing derived is persisted; everything is recomputed from raw day logs / sessions / max entries.
- Today's calorie targets come from data through *yesterday* (`targetsFor`).
- Units are lb; 3500 kcal/lb default.
- Design language: dark only, graphite + one lime accent (`--color-accent`), gold reserved for PRs/goals,
  hierarchy through type and spacing rather than borders. Mobile-first, ≥16px side gutters.
- Checks before committing: `npm run typecheck && npm test && npm run build`.
- Schema change: edit `src/server/db/schema.ts`, run `npm run db:generate`, commit the migration.
