# Strawvine — Product Spec

> A futuristic training journal. Sleek, calm, dense-but-breathable, quietly gamified.
> Built first for one athlete (the author) who is dogfooding it daily; structured cleanly
> enough to inspire a general-purpose product later.

Everything below describes the **current** program and preferences. They are examples, not
hard-coded behaviour: lifts, rep schemes, cycle length, percentages, progression rules,
weekly layout and targets are all user-editable data.

---

## 1. The athlete & the training

- CrossFit metcon — 6 days/week
- Zone 2 cycling — 30 min, 5 days/week
- Steps — 15,000/day
- Powerbuilding — 5 days/week (main compound lift → bodybuilding accessories → core couplet)
- Nutrition — the current focus; macros + calories logged daily as totals (meals tracked elsewhere)
- Bodyweight — logged every morning

## 2. Design principles

- **Fewer decisions.** Sensible defaults everywhere; prefill; one obvious next action.
- **Low friction.** Most logging is one or two taps; typing is rare.
- **Sleek & cool.** Premium sports-instrument feel, dark only.
- **Futuristic journal.** Breathable but dense; negative space and type hierarchy instead of boxes and
  borders; numbers as the hero; notes live inline with the metrics.
- **Calm colour, contrast where it matters.** Graphite surfaces, one accent for progress/action, a
  warm achievement colour reserved for PRs & milestones.
- **Adult gamification.** Earned, understated, satisfying. Completing things should feel *good*.
- **Nothing is set in stone.** Every training rule is configuration.

## 3. Daily logging

All fields are optional and can be edited at any time during the day (or later).

| Area | Fields |
|---|---|
| Morning check-in | body weight (lb), sleep score, HRV (ms), sleep duration, energy (1–5), soreness (1–5) |
| Nutrition | calories, protein, carbs, fat; optional micronutrients |
| Steps | daily count |
| Zone 2 | done + duration (default 30 min) |
| Metcon | done, optional notes, optional benchmark name (autocompleted from past ones) + score |
| Lifting | the session (see §6) |
| Journal | free-form text for the day |

- The day ends at **midnight local time**.
- Raw entries are the source of truth; **all derived numbers are recomputed** from them, so editing
  any past day ripples forward correctly.
- Today is shown live, marked *in progress*.

## 4. Energy engine (TDEE)

Units: **lb**, **3,500 kcal per lb**.

A day is **logged** only when it has **both** a weight and a calorie entry. Unlogged days are skipped
everywhere below.

### 4.1 Descending weighted 7-day average
```
avg(T) = (T0·5 + T1·5 + T2·5 + T3·4 + T4·3 + T5·2 + T6·1) / Σweights
```
`T0` = today, `T1` = yesterday… Applied separately to calories and weight. When a day in the window is
not logged its slot is skipped **and its weight is removed from the divisor** (e.g. T2 missing → ÷20).

### 4.2 Daily TDEE
```
TDEE(d) = avgCalories(d) − (avgWeight(d) − avgWeight(d−1)) × 3500
```
Computed only when day `d` is logged and both weight averages exist.

### 4.3 Smoothed TDEE
The same weighted formula applied to the last 7 daily TDEE values (skipping missing ones).

### 4.4 Recommendation
```
target calories = avgTDEE + (goal rate lb/week × 3500) / 7
```
- The user enters a **goal weight**; the rate is chosen as a pace (% bodyweight/week) within limits:
  lose ≤ **1%**/week, gain ≤ **0.5%**/week.
- The goal's **direction is fixed when it is set** (start weight vs goal). Reaching or overshooting the goal
  settles into maintenance — a cut never flips into a build (or vice versa) because of a scale wobble.
- **Taper:** a week never plans more change than is left to go: rate = min(pace × bodyweight, |remaining|),
  so the deficit/surplus eases out on the approach. Within ±0.5 lb of the goal → maintenance.
- The app projects a **target date range**: date at the chosen pace and date at the actually observed
  trend rate.
- **Target macros** are shown with target calories: protein from g/lb bodyweight, fat from g/lb,
  carbs fill the remaining calories (all ratios editable).

### 4.5 Calibration (ramp-up)
The smoothed TDEE needs ~14 logged days. During calibration the app shows what it can (marked
*provisional*), blends a starting estimate with the measured value as data accrues, and turns the ramp-up
into milestones (first weigh-in → averages online → first TDEE → calibrated).

### 4.6 Weekly check-in card
Smoothed TDEE, actual vs target rate, adherence, and next week's recommended calories & macros.

## 5. Goals

- Goal weight with projected date range.
- Strength targets per lift (e.g. Deadlift 600). A target is hit by a max entry at or above it dated on/after the day
  the target was set — never by a *correction* alone.
- PR tracking (max increases, AMRAP rep PRs, benchmark metcon bests).
- A **max PR** is a manual or AMRAP max at least **1 lb** above every earlier max of that lift (initial entries only
  set the baseline). Re-entering a lift's max within **10 minutes** of the previous entry is a *correction*: it
  replaces that entry (a typo never becomes a PR or a high-water mark), is compared against the history before it, and
  keeps the corrected entry's achievement so a fix is never celebrated twice.
- A max can also be recorded explicitly as a **correction** (source `correction`, e.g. fixing a typo days later). It
  becomes the lift's current max like any newer entry, is **never** celebrated as a PR, and *resets* the high-water mark:
  later PRs are measured against the corrected value, not the mistake it fixes. (A correction entered within 10
  minutes of the previous entry replaces that entry, as above, and stays a correction.)
- An **AMRAP rep PR** is a completed AMRAP set with more reps than every earlier AMRAP set of the same lift at the same
  or a heavier load. The first AMRAP at a load only sets the baseline; one per lift per session (its best set). Shown
  as "Bench press rep PR · 11 @ 200 lb".
- **Benchmark metcons** are matched by name ignoring case and spacing ("fran" = "Fran "). Scores are free text and
  parsed where possible:

  | Score | Kind | Better |
  |---|---|---|
  | `3:45`, `1:02:03` | time | lower |
  | `12+4`, `12 rounds` | rounds + reps | higher |
  | `225 lb`, `100 kg` | load (kg converted to lb) | higher |
  | `150`, `150 reps` | reps | higher |

  A finished time beats a rounds or reps score (capped); other mixed kinds aren't compared. A parseable score that
  beats the previous best for that benchmark is a **benchmark PR** ("Fran PR · 3:45 · previous 4:02"); a first-ever
  result only sets the baseline. The metcon editor shows the previous best.

## 6. Lifting

### 6.1 Tracked maxes
Back squat, front squat, deadlift, bench press, strict press (front squat tracked only, not currently
programmed). Maxes can be **edited manually at any time**; every change is recorded with date, source and
optional note.

### 6.2 Main lift calculation
- N-rep max = recorded max × rep-max % (editable table):

  | Reps | 1 | 2 | 3 | 4 | 5 | 6 | 8 | 10 | 12 |
  |---|---|---|---|---|---|---|---|---|---|
  | % | 100 | 95 | 93 | 90 | 87 | 85 | 80 | 75 | 70 |

  (gaps are interpolated)
- Working weight for a set of N reps = **90% of the N-rep max**, rounded to the nearest **5 lb**.
- 4 sets, ascending reps / descending weight. Five-week cycle:

  | Week | Reps |
  |---|---|
  | 1 | 6 / 8 / 10 / 12 |
  | 2 | 5 / 6 / 8 / 10 |
  | 3 | 4 / 5 / 6 / 8 |
  | 4 | 3 / 4 / 5 / 6 |
  | 5 | Deload: 4×10 @ 90% of the 12-rep max; accessories same reps @ ~80% load |

  Worked example (max 555, week 4): 3 @ 465, 4 @ 450, 5 @ 435, 6+ @ 425.

### 6.3 AMRAP progression (optional rule, on by default)
- The **last set of the main lift** is AMRAP, except on deload weeks and on days with progression off
  (e.g. the carry day).
- Each rep beyond target adds **+1 lb** to the max (6 prescribed, 9 achieved → +3 lb).
- Applies **immediately**, as a one-tap suggestion the user confirms.

### 6.4 Weekly layout (current)
| Day | Focus | Main lift |
|---|---|---|
| Mon | Push | Bench press |
| Tue | Pull | Deadlift |
| Wed | Legs | Back squat |
| Thu | Push | Strict press |
| Fri | Carries & pull | — (sandbag cleans/carries, farmer's carries, pull-ups) |

### 6.5 Accessories & supersets
- Exercises and their sets can be grouped into **supersets** (covers core couplets and any pairing).
- Sets measure reps, seconds or distance.
- Sessions pre-fill from the last session of the same day type (exercises, sets, last weights). On deload
  weeks accessory loads pre-fill at 80%.
- **Skip today:** an accessory can be marked skipped for one session. It stays in the session (and in next week's
  pre-fill, un-skipped, with the numbers from the last time it was actually done), but its sets don't count toward
  volume, PRs or hints.
- **Plan changed:** a saved session nothing has been logged in yet is flagged when its main lift no longer matches what
  the program would plan today (lift, deload, reps, AMRAP flags, target weights; added back-off sets are ignored), with
  a one-tap recalculation.
- **Progression hint:** when every logged set of an accessory's last (non-skipped) performance met its target reps with
  a load, the next session suggests that load + **5 lb** (editable; 0 turns hints off).
- Rest timer (targets editable: **180 s** after main-lift sets, **90 s** after accessories); plate calculator.

## 7. Gamification & feedback

- **Close the day**: today's checklist (weigh-in, nutrition, steps target, zone 2, metcon, lift as
  scheduled) — closing every item extends the streak.
- Streaks, PR moments, cycle completions, calibration milestones, strength-target hits, goal weight.
- Rule-based insights (protein adherence, sleep, HRV trend, steps, rate-of-change safety).
- Tasteful motion: smooth fills, a satisfying check, a restrained glow for PRs. Haptics where available.
- Optional **high-contrast "outdoor" mode** (brighter secondary text, thicker chart lines) for gym glare.

## 8. Platform

- TypeScript; React + Vite (installable PWA) frontend; Hono API on Node; Drizzle ORM.
- Postgres (Heroku Postgres in production).
- One Docker image (API + static frontend), deployed to Heroku's container stack.
- Single-user password auth with a long-lived signed session cookie that renews while in use. Signing out signs
  every device out; changing the password does too, and so does restoring an export.
- Offline-first: every edit is stored on the device and replayed in order until the server confirms it. Creates carry
  an `Idempotency-Key`, so a retry after a lost response never duplicates a row (keys are kept 7 days). Settings shows
  when the device last synced, what is still unsynced, and "Sync now"; Today marks rows with unsynced edits and ticks
  "saved" when the server confirms one. After onboarding the app asks the browser for persistent storage so the
  offline copy isn't evicted.
- Pure, unit-tested domain modules for all calculations.
