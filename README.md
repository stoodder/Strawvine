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
src/server   Hono API, auth, Drizzle schema & migrations runner
src/web      React app (screens, components, data layer)
drizzle/     SQL migrations (applied automatically on boot)
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

## Deploying to Heroku

The app ships as a container (`heroku.yml` → `Dockerfile`). Migrations run on boot.

```sh
heroku create <app-name>
heroku stack:set container
heroku addons:create heroku-postgresql:essential-0
heroku config:set APP_PASSWORD='<your password>' SESSION_SECRET="$(openssl rand -hex 32)"
git push heroku <branch>:main
heroku open
```

`DATABASE_URL` and `PORT` are provided by Heroku. On your phone, open the app and use **Add to Home Screen** to install it.

### Environment

| Variable | |
|---|---|
| `DATABASE_URL` | Postgres connection string (TLS is used automatically for non-local hosts) |
| `APP_PASSWORD` | the single sign-in password |
| `SESSION_SECRET` | ≥ 32 random characters; signs the session cookie (rotate to sign out everywhere) |
| `PORT` | default 3000 |

## Data

Settings → **Export JSON** downloads everything. Nothing derived is stored; the export is the complete source of truth.
