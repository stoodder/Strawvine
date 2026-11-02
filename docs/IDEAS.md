# Ideas & follow-ups

Collected from three rounds of adversarial reviews (security, data integrity, UX, design/accessibility,
performance/ops/CI) and the implementation passes. Nothing here is required for daily use; it's a menu.
Rough priority within each group. Items already built have been removed.

## Data & sync

- **Incremental sync** (`/bootstrap?since=<version>`, per-collection deltas): sessions are ~80% of a multi-year
  payload, and any device switch currently means one full download.
- Bootstrap's data queries in one REPEATABLE READ snapshot with the version, so tag and body always match exactly.
- Client-generated UUIDs for rows (removes temp-id remapping and dependency holds); stable ids for block exercises.
- Persist the "merge once" state and pending merge toasts in the outbox entry so they survive a reload / window handoff.
- Pair rebuilt accessory blocks by exercise fingerprint when two devices rebuilt the same session.
- Version-check day-log patches field by field (today they're last-writer-wins per field).
- A periodic prune of `revoked_sessions`; move session-prefill helpers onto a per-weekday index.

## Training

- A per-set `skipped` flag so "skip rest of main lift" keeps the sets visible (today they're removed, with Restore).
- On the source day of a moved session, offer "Do today's own plan instead".
- Plate inventory and bar weight in Settings (`platesPerSide` uses defaults; odd loads show a remainder).
- Interleaved superset order (A1, B1, A2, B2); swipe-to-skip on accessory rows.
- `accessoryHint` returning its date as a field; a "dismiss for today" that also covers hold hints across devices.
- Preview: projected AMRAP-driven max changes; a configurable horizon.
- Benchmark history rows link to their day and show a sparkline; "CAP+12" scores; kg/lb preference.

## Daily logging

- Settings-level aliases for app-specific nutrition labels; optional one-decimal macros.
- Heatmap long-press preview; a 1-year / 2-year range on Progress between 90 days and All.
- Evening steps reminder (web push; iOS requires the installed app).

## Motivation & feedback

- Shareable session recap and weekly check-in images (best hint applied, skipped exercises, vs. last same weekday).
- Recap line "Bench press · 3 sets skipped" after skip-rest.
- Streak protection tied to deload/rest days.
- Optional AI-written weekly check-in on top of the rule-based signals.

## Design & accessibility

- Heatmap partial vs. empty cells at 3:1 (today ≈1.35:1 — would change the look; the data is in each cell's label).
- A dedicated high-contrast top edge for sheets.
- `content-visibility: auto` on the full achievements list; rest-time "3:30?" preview under the field instead of inline.
- Lint: arbitrary rem sizes outside the type scale and `bg-white/[…]` alphas are already checked; next, a contrast unit
  test computed from the `@theme` tokens.

## Engineering

- Drop `'unsafe-inline'` from the enforced CSP once the Report-Only trial stays empty for a week.
- Move GitHub Actions to their Node 24 majors when Dependabot proposes them; pin images by digest.
- Shard e2e or snapshot one onboarded database per worker; run axe on a several-year dataset.
- Reorder the idempotent exercise create's locks to match restore's (removes a rare deadlock window).
- `LazyMotion` (`m.*` everywhere) for ~60–100 KB once the bottom-nav and sheet animations can use `domAnimation`.
- Optional passkey / PIN app lock before showing cached data; login alerts; zxcvbn-style `APP_PASSWORD` check.
