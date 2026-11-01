# Ideas & follow-ups

Collected from two rounds of adversarial reviews (security, data integrity, UX, design/accessibility,
performance/ops/CI) and the implementation passes. Nothing here is required for daily use; it's a menu.
Rough priority within each group. Items already built have been removed.

## Data & sync

- **Version-checked whole-document saves.** Sessions and settings are saved whole; a stale window that saves before
  its revalidation returns can still overwrite. Add `If-Match` (revision / `updatedAt`) → 409 → reload and re-apply.
- **Writes return the new dataset version** so the client's stored ETag stays current (today, returning to the app
  after your own writes costs one full download instead of a 304).
- **Incremental sync** (`/bootstrap?since=`, per-collection deltas) for multi-year datasets.
- Client-generated UUIDs for rows (removes temp-id remapping and dependency holds).
- Idempotency: also verify the body hash on replay from older clients; move the login limiter state to Postgres so it
  holds across dynos.
- A "Couldn't save" banner in Settings → Sync for edits refused at queue time (today: a toast).
- Cross-window sender lock in a SharedWorker where available.

## Training

- "Do this session today": swap a previewed day into today (travel / rest-day Sunday).
- "Skip main lift today" (injury) without unlogged-set prompts.
- Per-exercise rest targets; next set's plates inside the rest pill.
- Interleaved superset order (A1, B1, A2, B2); swipe-to-skip on accessory rows.
- Progression hint: "dismiss for today", a "hold" hint after missed reps, pyramid-aware suggestions
  (today it suggests the heaviest load + increment for every open set).
- Preview: projected AMRAP-driven max changes; a configurable horizon; link from Today's next session.
- A per-benchmark history sheet; "CAP+12" time-capped scores; kg/lb preference.
- Explicit choice whether a correction should hide the PR earned by the typo it fixes.

## Daily logging

- Settings-level aliases for app-specific nutrition labels; optional one-decimal macros.
- Heatmap: long-press preview before navigating, month labels.
- Evening steps reminder (web push; iOS requires the installed app).
- Bigger / tappable pending-sync indicator on Today's date ("tap to sync now").

## Motivation & feedback

- Shareable session recap and weekly check-in (best hint applied, skipped exercises, vs. last same weekday).
- Day-closed sweep also when returning to Today after finishing a lift elsewhere; optional soft sound.
- Streak protection tied to deload/rest days.
- Optional AI-written weekly check-in on top of the rule-based signals.

## Design & accessibility

- Settings jump list (the page is long at 320 px); rest settings shown as m:ss.
- Downsample the bodyweight dots to weekly points for ranges over ~1 year.
- Profile IntakeStrip (`targetsFor` ×7 per render) and the remaining ~150 ms model build on 10-year data.
- `useFocusAfter` that retries a few frames and skips inert targets (Train uses a local `focusWhenReady`).
- `DateJump` optional `max` prop (Train passes today + 14 as `today`); dock top edge in context for scroll helpers.
- Small leftovers: focus after the skip toast's Undo; rest pill widens slightly when "/3:00" appears.
- Lint: flag `text-mute` on tinted surfaces; arbitrary rem sizes outside the type scale; `bg-white/[…]` bypassing tokens.

## Engineering

- Pin GitHub Actions to commit SHAs (Dependabot keeps them current); `lock_timeout` on migration statements.
- A periodic "restore the export into a fresh database" check; Server-Timing headers on `/api/bootstrap`.
- e2e: paste → Undo, the sign-out question, celebration hold, Settings renames, high-contrast persistence,
  a toast's Undo while a sheet is open, axe checks per sheet, `activeElement !== body` after key actions,
  `scrollWidth <= clientWidth` per screen at 195 px.
- `LazyMotion` (`m.*` everywhere) for ~60–100 KB; name the shared vendor chunk.
- Optional passkey / PIN app lock before showing cached data; "forget this device"; login alerts;
  zxcvbn-style check for `APP_PASSWORD`.
- CSP: trial dropping `style-src 'unsafe-inline'` with Report-Only.
