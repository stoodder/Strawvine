# Ideas & follow-ups

Collected from the adversarial reviews (security, design, UX, accessibility, reliability) and the fix passes.
Nothing here is required for daily use; it's a menu to pick from. Rough priority within each group.

## Data & sync

- **Idempotent creates.** Offline-created exercises/maxes can duplicate if a POST times out after the server applied
  it. Accept an `Idempotency-Key` (or client-generated UUID ids, which would also remove temp-id remapping).
- **Conflict safety across devices.** Sessions are whole documents (last write wins). Add `updatedAt`/If-Match.
- **Incremental sync** (`/bootstrap?since=`) so refetches stay small as years of data accumulate; a per-table version
  so unchanged data can 304 without a DB read.
- Call `navigator.storage.persist()` after onboarding so iOS is less likely to evict the offline copy.
- Settings → "Last synced", list of unsynced changes, "Sync now".
- Bump the session epoch after a database restore (a restore rolls revocations back).

## Training

- **Real "skip today"** for an accessory without dropping it from next week's template (needs a schema field).
- **Preview future sessions** read-only (Train currently stops at today).
- Per-exercise rest targets (e.g. main lift 180 s, accessories 90 s); next set's plates inside the rest pill.
- "Log all remaining sets" for an exercise / superset round; interleaved superset order (A1, B1, A2, B2).
- Accessory progression hints ("hit all reps last week → +5").
- Benchmark metcon library with autocomplete, previous best and PR moments; AMRAP rep PRs (both promised in SPEC §5).
- An explicit "correction" source for max edits so fixing an old typo days later isn't celebrated.
- A shared `planMatches(session, program)` helper so Today and Train agree on "plan changed".

## Daily logging

- Paste nutrition totals from the meal app in one go (e.g. "2140 212 150 70").
- Evening steps reminder (web push requires the app installed to the home screen on iOS).
- Date picker on Today/Train headers; tap a heatmap day to open it.
- Small "saved" tick on inline fields; per-row pending indicator when the outbox holds that day's writes.

## Motivation & feedback

- Session recap and weekly check-in as share-worthy moments; a lighter "day closed" ring sweep on Today.
- Streak protection tied to deload/rest days.
- Optional AI-written weekly check-in on top of the rule-based signals.

## Design & accessibility

- High-contrast "outdoor" mode for gym glare (thicker chart lines, brighter muted text); Dynamic Type support.
- Charts: "view as table" disclosure, min/max axis labels, 7-day intake-vs-target strip.
- `InlineText` primitive for inline renames; `Label`/`Value` primitives to stop type-scale drift.
- Lint rule against `text-faint` on information-bearing text and px font sizes.
- Rest timer and toasts can stack over the bottom of the page; give them a shared bottom "dock".

## Engineering

- CI: `npm run typecheck && npm test && npm run build`, Docker build, `npm audit --omit=dev`, Dependabot/Renovate.
- Promote the Playwright walkthroughs (onboarding, logging, training, offline/sync, celebrations) into `e2e/` in CI.
- Component tests for `Sheet` (focus trap/inert/restore), `Stepper` editable, `DotScale` keys.
- Drop the remaining client zod imports (Onboarding `dayLogFields`) and consider `LazyMotion` (~88 KB + ~60 KB).
- Code-split Progress/Goals/Settings/Onboarding; `Server-Timing` and simple client performance metrics.
- Optional passkey / PIN lock before showing the offline copy; login alerts.
