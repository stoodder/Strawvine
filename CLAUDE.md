# Strawvine — notes for Claude

- Product spec: `docs/SPEC.md` (source of truth for formulas and behaviour). The athlete's program is *example data*:
  every training rule must stay configurable via `Settings`, never hard-coded.
- Domain logic is pure and lives in `src/shared` (tested with vitest). UI and API must not reimplement formulas.
- Nothing derived is persisted; everything is recomputed from raw day logs / sessions / max entries.
- Today's calorie targets come from data through *yesterday* (`targetsFor`).
- Units are lb; 3500 kcal/lb default.
- Design language: dark only, graphite + one lime accent (`--color-accent`), gold reserved for PRs/goals,
  hierarchy through type and spacing rather than borders. Mobile-first, ≥16px side gutters.
- Checks before committing: `npm run typecheck && npm run check:style && npm test && npm run build`.
  `npm test` runs two vitest projects: `node` (`*.test.ts`) and `web` (jsdom + Testing Library, `src/web/**/*.test.tsx`).
  `npm run e2e` (Playwright, `e2e/`) builds, starts the server on a fresh `E2E_DATABASE_URL` (default
  `postgres://postgres@localhost:5432/strawvine_e2e`, dropped/recreated) and runs the suite; CI runs all of this
  (`.github/workflows/ci.yml`).
- `check:style` fails on `text-faint` for information (mark decoration with a `// decor` comment) and on px font sizes
  (`text-[11px]` → rem); existing violations are ratcheted in `scripts/check-style-baseline.json`
  (`node scripts/check-style.mjs --update-baseline` after fixing some).
- Transient bottom UI (toasts, sync pill, rest timer) renders into the dock: `<DockItem id priority>` from
  `components/Dock.tsx`, never its own `fixed bottom-…` layer. Inline renames use `components/InlineText.tsx`.
- Screens that aren't a day take their header from `components/ScreenHeader.tsx` (one h1 size and top rhythm).
- An Undo of a settings change goes through `components/settings/undo.ts`: a toast outlives its screen, so Undo patches
  the settings as they are when it is tapped (`liveSettings`), only its own fields — never a remembered document.
- Schema change: edit `src/server/db/schema.ts`, run `npm run db:generate`, commit the migration.
