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

| | |
|---|---|
| Weighted 7-day average | `(T0·5 + T1·5 + T2·5 + T3·4 + T4·3 + T5·2 + T6) / 25`; missing days drop out of the divisor. A day counts only with **both** weight and calories. |
| Daily TDEE | `avgCalories − (avgWeight(today) − avgWeight(yesterday)) × 3500` |
| Smoothed TDEE | the same weighted average over daily TDEEs |
| Target calories | `TDEE + (pace × bodyweight × 3500) / 7`, pace capped at −1% / +0.5% bodyweight per week |
| Today's targets | built from data **through yesterday**, so they don't move while you log meals |
| Calibration | for the first 14 logged days the TDEE blends your starting estimate with the measured value |

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
`npm run db:migrate` applies migrations without starting the server.

### Builds

`npm run build` builds the web app (Vite), bundles the server entry points (`dist/server/index.js`, `migrate.js`,
`restore.js`), writes Brotli/gzip copies of the web assets, and stamps the build:

- `BUILD_ID` (default: the Unix time of the build; override with `BUILD_ID=<sha> npm run build` or
  `docker build --build-arg BUILD_ID=<sha>`) is exported for both steps. Vite compiles it into the client as
  `__BUILD_ID__`; the server reads it back from `dist/build-id.txt` at boot and sends it as the `x-strawvine-build`
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
is shorter than 12 characters or a known default. The log says exactly what to fix.

### Environment

| Variable         |                                                                                                                                                                                         |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`   | Postgres connection string (TLS is used automatically for non-local hosts)                                                                                                              |
| `APP_PASSWORD`   | the single sign-in password (production: 12+ characters)                                                                                                                                |
| `SESSION_SECRET` | signs session cookies; production requires `openssl rand -hex 32` strength                                                                                                              |
| `NODE_ENV`       | `production` in the image: secure `__Host-` cookie, HTTPS redirect, strict secret checks                                                                                                |
| `TRUST_PROXY`    | `1` to trust `X-Forwarded-For`/`-Proto` from a TLS-terminating proxy (login rate limiting by client IP, HTTP→HTTPS redirect). Defaults to on when `DYNO` is set (Heroku), off elsewhere |
| `BUILD_ID`       | optional override for the build id (see _Builds_)                                                                                                                                       |
| `PORT`           | default 3000                                                                                                                                                                            |

### Sessions

Signing in sets a 180-day cookie that renews itself while the app is in use. **Sign out signs out every device**
(the session epoch stored in `auth_state` moves on). Changing `APP_PASSWORD` or `SESSION_SECRET`, or restoring an
export, also signs every device out.

### Offline writes

Edits are queued on the device and replayed in order. `POST /api/exercises` and `POST /api/exercises/:id/maxes`
accept an `Idempotency-Key` header (8–80 characters of `A-Z a-z 0-9 . _ : -`); the client generates one per create and
persists it with the queued edit. A repeated key returns the first response (with `Idempotent-Replayed: true`) instead of
creating the row again; reusing a key for a different request is a 422. Keys live in `idempotency_keys` and are pruned
after 7 days.

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
seed — unless you add `--force`. Older, unversioned exports are accepted too.

A database-level rollback (`heroku pg:backups:restore`) also rolls `auth_state` back, which can revive cookies that were
signed out after the backup. Move the epoch past anything issued since:

```sh
heroku pg:psql -c "update auth_state set session_epoch = session_epoch + 1000, updated_at = now() where id = 1"
```
