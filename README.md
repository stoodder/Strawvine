# Strawvine

A futuristic training journal — training, fuel and recovery in one calm, fast, installable web app.
Built to be dogfooded daily by one athlete; see [`docs/SPEC.md`](docs/SPEC.md) for the full product spec.

- **Today** — close the day: weigh-in & recovery, nutrition vs. calorie/macro targets, steps, zone 2, metcon, lift.
- **Train** — the main lift calculated from your max (90% of the N-rep max, rounded to 5 lb), AMRAP last set with one-tap
  max progression, accessories & supersets carried over from last week, rest timer, plate math.
- **Progress** — weekly check-in, weighted-average weight trend, measured TDEE vs. intake, max history.
- **Goals** — goal weight with projected date range, strength targets, streak heatmap, achievements.
- **Settings** — every rule (cycle weeks, rep schemes, percentages, deload, weekly layout, targets, limits) is editable.

## How the numbers work

|                        |                                                                                                                                                   |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Weighted 7-day average | `(T0·5 + T1·5 + T2·5 + T3·4 + T4·3 + T5·2 + T6) / 25`; missing days drop out of the divisor. A day counts only with **both** weight and calories. |
| Daily TDEE             | `avgCalories − (avgWeight(today) − avgWeight(yesterday)) × 3500`                                                                                  |
| Smoothed TDEE          | the same weighted average over daily TDEEs                                                                                                        |
| Target calories        | `TDEE + (pace × bodyweight × 3500) / 7`, pace capped at −1% / +0.5% bodyweight per week                                                           |
| Today's targets        | built from data **through yesterday**, so they don't move while you log meals                                                                     |
| Calibration            | for the first 14 logged days the TDEE blends your starting estimate with the measured value                                                       |

All derived values are recomputed from raw entries — edit any past day and everything after it updates.

## Stack

TypeScript everywhere · React 19 + Vite + Tailwind 4 + Motion (PWA) · Hono on Node 22 · Drizzle ORM · Postgres ·
one Docker image. Domain logic lives in `src/shared` as pure, unit-tested functions used by both client and server.

```
src/shared   domain logic (energy engine, program maths, sessions, goals, gamification) + zod schemas
src/server   Hono API, auth, Drizzle schema, migrate / restore entry points
src/web      React app (screens, components, data layer)
drizzle/     SQL migrations (applied by Heroku's release phase, and on boot under an advisory lock)
```

## Local development

Requires Node 22+ and Postgres.

```sh
cp .env.example .env          # set DATABASE_URL, APP_PASSWORD, SESSION_SECRET
npm install
npm run dev                   # API on :3000, web on :5173 (proxied)
```

Or run the production image with its own database:

```sh
docker compose up --build     # http://localhost:3000 — password "strawvine" unless APP_PASSWORD is set
```

Checks:

```sh
npm test          # unit + API tests (API tests use TEST_DATABASE_URL, default postgres://postgres@localhost:5432/strawvine_test)
npm run typecheck
npm run build
```

Schema changes: edit `src/server/db/schema.ts`, then `npm run db:generate` and commit the new file in `drizzle/`.
`npm run db:migrate` applies migrations without starting the server. CI fails when `drizzle/` is out of date with the
schema.

The API tests drop and recreate the schema of `TEST_DATABASE_URL`, so they refuse to run unless the database name
contains `test` and the host is local (`CI=true` lifts the host check). `npm run e2e` likewise only resets a database
whose name contains `e2e`, on a local host.

#### Migrations must be backward compatible

The release phase migrates the database **before** the new dynos start, so for a while the old release runs against
the new schema (and a rollback runs the old code on it indefinitely). Every migration has to work with the code that
was live before it — expand, then contract:

1. **Expand** (one deploy): add new tables/columns as nullable or with a default; never rename or drop in the same
   deploy. Code reads the old and the new shape.
2. **Migrate data** if needed (in code or a follow-up migration), then switch the code over to the new shape.
3. **Contract** (a later deploy, once no running release uses it): drop the old column/table.

Avoid long table rewrites and locks: a booting dyno waits at most 30 s for the migration lock (Heroku kills a dyno that
doesn't bind its port within 60 s) and the release phase at most 15 minutes.

### Builds

`npm run build` builds the web app (Vite), bundles the server entry points (`dist/server/index.js`, `migrate.js`,
`restore.js`), writes Brotli/gzip copies of the web assets, and stamps the build:

- `BUILD_ID` (default: the Unix time of the build; override with `BUILD_ID=<sha> npm run build` or
  `docker build --build-arg BUILD_ID=<sha>`) is a **build-time** input, exported for both steps. Vite compiles it into
  the client as `__BUILD_ID__`; the server reads it back from `dist/build-id.txt` at boot — never from the runtime
  environment, which could disagree with what the client was compiled with — and sends it as the `x-strawvine-build`
  header on every `/api/*` response, so an open client can tell a newer deploy is live. No header is sent in dev
  (no `dist/build-id.txt`).

## Deploying to Heroku

The app ships as a container (`heroku.yml` → `Dockerfile`, Node pinned to an exact `22.x.y-alpine` image). Each deploy
runs a **release phase** (`node dist/server/migrate.js`: migrations + first-boot seed, under a Postgres advisory lock)
before the new dynos start; if it fails the deploy is aborted and the previous release keeps running.

```sh
heroku create <app-name>
heroku stack:set container
heroku addons:create heroku-postgresql:essential-0
heroku config:set APP_PASSWORD='<a password of 12+ characters>' SESSION_SECRET="$(openssl rand -hex 32)"
git push heroku <branch>:main
heroku open
```

`DATABASE_URL` and `PORT` are provided by Heroku. On your phone, open the app and use **Add to Home Screen** to install it.

In production the server **refuses to boot** when `SESSION_SECRET` is a placeholder (the values in `.env.example` /
`docker-compose.yml`) or weaker than `openssl rand -hex 32` (64+ hex or 43+ base64 characters), or when `APP_PASSWORD`
is shorter than 12 characters (surrounding spaces don't count), uses fewer than 6 different characters, or is a known
default. The log says exactly what to fix.

### Environment

| Variable         |                                                                                                                                                                                         |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`   | Postgres connection string (TLS is used automatically for non-local hosts)                                                                                                              |
| `APP_PASSWORD`   | the single sign-in password (production: 12+ characters)                                                                                                                                |
| `SESSION_SECRET` | signs session cookies; production requires `openssl rand -hex 32` strength                                                                                                              |
| `NODE_ENV`       | `production` in the image: secure `__Host-` cookie, HTTPS redirect, strict secret checks                                                                                                |
| `TRUST_PROXY`    | `1` to trust `X-Forwarded-For`/`-Proto` from a TLS-terminating proxy (login rate limiting by client IP, HTTP→HTTPS redirect). Defaults to on when `DYNO` is set (Heroku), off elsewhere |
| `BUILD_ID`       | **build time only** (`npm run build` / `docker build --build-arg`): labels the build (see _Builds_). Ignored at runtime                                                                 |
| `PORT`           | default 3000                                                                                                                                                                            |

### Sessions

Signing in sets a 180-day cookie that renews itself while the app is in use. **Sign out signs out every device**
(the session epoch stored in `auth_state` moves on) and answers with `Clear-Site-Data: "cache"`. Changing
`APP_PASSWORD` or `SESSION_SECRET`, or restoring an export, also signs every device out: the signing key mixes in a random
per-database salt (`auth_state.key_salt`) that a restore replaces, so even a restore into a fresh database (whose epoch
starts over) can't revive an old cookie. Databases from before the salt existed keep an unsalted key until their next
restore, so upgrading signs nobody out.

Failed sign-ins are rate limited per network (IPv4 /24, IPv6 /64): 10 failures in 15 minutes block that network for a
while (429 with `Retry-After`). Beyond 50 failures an hour across all clients, sign-ins from unknown devices are slowed
down (a serialised tarpit, doubling delays capped at 10 s; refused when the queue is longer). A successful sign-in marks
the browser as a **known device** (`sv_device`, a signed, httpOnly 400-day cookie kept across sign-outs; a password change
forgets every device): known devices skip the tarpit and are limited per device rather than per network, so the owner
isn't locked out by someone else's guessing. Settings → **Forget this device** (`POST /api/auth/forget-device`) signs
only that browser out, drops its known-device cookie and wipes everything the app stored there; other devices stay
signed in. The session token is revoked on the server as well (a sha256 of it is kept in `revoked_sessions` until the
token would have expired), so a copy of the cookie — or a browser that never applied the response — is signed out too.
Each process caches the revoked list with the epoch for at most 5 s.

Any `/api/*` request that the browser marks as sent by another site (`Sec-Fetch-Site` present and neither `same-origin`
nor `none`) is refused with 403 — reads too, so a link or navigation from another site can't make the browser fetch the
data set or download the export with your cookie. Writes additionally need a same-host `Origin` (when sent) and a JSON
body.

The web server's database pool sets `statement_timeout` to 10 s (`createWebDb`), so a stuck query or lock wait fails
its request instead of holding a connection; migrations, the release phase and restores run without one.

`GET /api/bootstrap` is sent with `Cache-Control: no-store` (health data never lands in the browser's HTTP cache) and an
`ETag` built from the data set's version; a request with a matching `If-None-Match` gets a `304` without the data set
being read. JSON responses are compressed with Brotli (or gzip).

The version is a counter (`dataset_version`, one row) that a trigger on every data table (`day_logs`, `sessions`,
`exercises`, `max_entries`, `settings`, `seen_achievements`) bumps **once per writing transaction, inside that
transaction** — whichever process, release or `psql` session made the write. The ETag hashes the counter with the build
id and the session epoch + key salt (a restore, or the epoch bump below after a database-level rollback, moves those on,
so a counter that starts over never repeats a tag a device holds). Every successful write answers with the data set's
version after it (`x-dataset-etag`) and just before it (`x-dataset-etag-prev`), read at the end of its own transaction.
Both are exact: the bump holds the counter row until the write commits, so no other write — in this process, on another
dyno or from an older release — can land in between. A client whose copy was at the "before" version adopts the new
one, so coming back to the app after your own edits is a `304` instead of a full download (3-year data set: 165 KB Brotli
/ ~70 ms → 0 B / ~5 ms); a client that missed a write never matches `prev` and downloads it. A write that changes nothing
(an idempotent replay, deleting a session that isn't there) answers with the current version as both. The tag is read
before the data, so a write committing during a bootstrap can only make the body newer than its tag (one extra download
later), never older. Cost at ten years of data: a `304` takes one primary-key lookup (~0.8 ms end to end, was ~2.7 ms
with the old per-table stamp), and a write's version headers ~0.4 ms (was ~5 ms).

`Server-Timing` is sent on `/api/bootstrap` (`db` = version lookup + queries, `build` = JSON, `compress` = Brotli/gzip) and
on writes (`db` = the handler, `etag` = reading the data-set version in its transaction). Browser dev tools show it under
Network → Timing; from a shell: `curl -s -D - -o /dev/null -b cookies.txt -H 'accept-encoding: br' https://<app>/api/bootstrap`.

Workouts and settings are saved as whole documents and **version-checked**: `GET /api/bootstrap` includes `revs`
(the settings' revision and each session's — Postgres' `xmin` for the row, no column of its own), the client sends the
revision an edit was based on as `If-Match` (or `If-None-Match: *` for a workout it believes is new), and a stale one is
answered `409 { error: "conflict", current, rev }`. The client merges its edit onto `current` and retries once (see
docs/SPEC.md §8). `If-None-Match: *` is atomic: when another save (in any process) creates the workout first, this one
is a 409 with that save's copy. `DELETE /api/sessions/:date` honours `If-Match` the same way: a workout changed since the
revision the delete was based on is a 409 with the current copy, which the client keeps. Requests without either header
are accepted as before (older clients). A restore or `pg_restore` changes
every revision, so each device's next save of a workout or the settings goes through one merge.

### Content-Security-Policy trial

The enforced policy still allows inline styles (`style-src 'self' 'unsafe-inline'`). Every response also carries
`Content-Security-Policy-Report-Only` with the same policy **without** `'unsafe-inline'`, reporting to
`POST /api/csp-report` (`report-uri`, which every engine delivers right away; `report-to` is left out because Chromium
then ignores `report-uri` and batches reports through the Reporting API). Nothing is blocked by it. The endpoint needs no sign-in, takes at most 8 KB, is rate limited (30 reports a minute per
network, 300 overall; 429 beyond) and logs a line per violation with only the directive and the blocked resource's host
or keyword (at most 100 characters) — never the page, the source file or a sample. Each distinct (directive, host) pair
is logged at most once a minute, at most 2 lines per report and 20 a minute in all, so the log shows _which_ violations
happen, not how often:

```
CSP violation (report-only) {"directive":"style-src-attr","blocked":"inline"}
```

To read the results, use the app normally for a few days (every screen, sheets, charts, celebrations), then:

```sh
heroku logs -n 1500 --source app | grep 'CSP violation' | sed 's/.*{/{/' | sort | uniq -c | sort -rn   # count = minutes seen
```

`style-src-attr … inline` means a `style="…"` attribute in markup (index.html, an HTML/SVG string, `setAttribute("style",
…)`) — styles React (`style={{…}}`) and motion set through `element.style` are not affected — and
`style-src-elem … inline` a `<style>` element (in index.html or added at runtime). When the list stays empty across a full week of use,
`'unsafe-inline'` can be dropped from the enforced policy (`CSP` in `src/server/app.ts`) and the report-only header
removed. A local probe of every screen (Chromium, 3-year data set) produced no style reports. Expect
`{"directive":"script-src","blocked":"eval"}` on opening Settings: zod (used there to validate the program) probes whether
`Function("")` is allowed inside a `try`; the enforced policy blocks it the same way, and zod falls back to its
interpreter (`z.config({ jitless: true })` would skip the probe).

### Offline writes

Edits are queued on the device and replayed in order. `POST /api/exercises` and `POST /api/exercises/:id/maxes`
accept an `Idempotency-Key` header (8–80 characters of `A-Z a-z 0-9 . _ : -`); the client generates one per create and
persists it with the queued edit. A repeated key returns the first response (with `Idempotent-Replayed: true`) instead of
creating the row again; reusing a key for a different request — another path, or another body (compared by a hash of the
parsed body) — is a 422. Keys live in `idempotency_keys` and are pruned after 7 days (hourly while running, and on every
boot/release); deleting a max entry forgets the key that created it. A queued max entry also carries the time it was made
on the device (`createdAt`, trusted within the last 30 days), so a backlog flushed at once keeps its real order.

### Backups

Heroku Postgres keeps no backups by default on the smallest plans. Schedule daily ones and take a manual one before
each deploy that touches the schema:

```sh
heroku pg:backups:schedule DATABASE_URL --at '04:00 America/New_York'
heroku pg:backups:capture             # before a deploy
heroku pg:backups                     # list
heroku pg:backups:download            # latest.dump, restorable with pg_restore
heroku pg:backups:restore <backup-id> DATABASE_URL   # roll the whole database back
```

The app-level export (below) is a second, database-independent copy.

## Data

Settings → **Export JSON** (`GET /api/export`) downloads everything: settings, every day log, exercise, max entry,
session and seen achievement, with their ids (format `strawvine-export`, version 2). Nothing derived is stored; the
export is the complete source of truth.

To restore an export into a database:

```sh
DATABASE_URL=postgres://… npm run restore -- strawvine-export-2026-11-01.json            # local / any reachable DB
DATABASE_URL="$(heroku config:get DATABASE_URL)" npm run restore -- export.json          # Heroku, from your machine
heroku run --no-tty "node dist/server/restore.js -" < export.json                        # Heroku, inside a dyno
```

The restore applies migrations, then replaces everything in a single transaction (rows keep their ids; id sequences
are moved past them) and **signs every device out** (the session epoch moves on, so a cookie revoked before the restore
can't come back). It refuses to run on a database that already has data — anything beyond the untouched first-boot
seed, including exercises you created, renamed or archived — unless you add `--force`. Older, unversioned exports are
accepted too. On failure it prints what went wrong (error name, code, database detail), never the data.

A database-level rollback (`heroku pg:backups:restore`) also rolls `auth_state` back, which can revive cookies that were
signed out after the backup, and rolls the data set's version counter back. Move the epoch past anything issued since
(this also changes every device's data-set ETag, so none mistakes the rolled-back data for the copy it holds):

```sh
heroku pg:psql -c "update auth_state set session_epoch = session_epoch + 1000, updated_at = now() where id = 1"
```
