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
| Metcon | done, optional notes, optional benchmark name + score |
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
- Strength targets per lift (e.g. Deadlift 600).
- PR tracking (max increases, AMRAP rep PRs, benchmark metcon bests).

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
- Rest timer; plate calculator.

## 7. Gamification & feedback

- **Close the day**: today's checklist (weigh-in, nutrition, steps target, zone 2, metcon, lift as
  scheduled) — closing every item extends the streak.
- Streaks, PR moments, cycle completions, calibration milestones, strength-target hits, goal weight.
- Rule-based insights (protein adherence, sleep, HRV trend, steps, rate-of-change safety).
- Tasteful motion: smooth fills, a satisfying check, a restrained glow for PRs. Haptics where available.

## 8. Platform

- TypeScript; React + Vite (installable PWA) frontend; Hono API on Node; Drizzle ORM.
- Postgres (Heroku Postgres in production).
- One Docker image (API + static frontend), deployed to Heroku's container stack.
- Single-user password auth with a long-lived signed session cookie.
- Pure, unit-tested domain modules for all calculations.
