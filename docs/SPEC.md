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
- **Adult gamification.** Earned, understated, satisfying. Completing things should feel _good_.
- **Nothing is set in stone.** Every training rule is configuration.

## 3. Daily logging

All fields are optional and can be edited at any time during the day (or later).

| Area             | Fields                                                                                |
| ---------------- | ------------------------------------------------------------------------------------- |
| Morning check-in | body weight (lb), sleep score, HRV (ms), sleep duration, energy (1–5), soreness (1–5) |
| Nutrition        | calories, protein, carbs, fat; optional micronutrients                                |
| Steps            | daily count                                                                           |
| Zone 2           | done + duration (default 30 min)                                                      |
| Metcon           | done, optional notes, optional benchmark name (autocompleted from past ones) + score  |
| Lifting          | the session (see §6)                                                                  |
| Journal          | free-form text for the day                                                            |

- The day ends at **midnight local time**.
- Raw entries are the source of truth; **all derived numbers are recomputed** from them, so editing
  any past day ripples forward correctly.
- Today is shown live, marked _in progress_.

### 3.1 Fuel bars (Today)

The calorie bar and each macro bar fill toward the day's target (§4.4). Going over is shown on a colour scale
rather than a switch: **on target** (accent lime) up to a tolerance over, then the bar shades through a
**caution yellow** to the **warn red** as the overage grows, mixed continuously in between. The scale is a 0–1
severity (`overTargetSeverity`, `src/shared/nutrition.ts`): 0 within the tolerance, rising linearly to 1 at "fully
over", and staying there beyond.

| Bar                  | Tolerance (stays lime) | Halfway (yellow) | Fully over (red) |
| -------------------- | ---------------------- | ---------------- | ---------------- |
| Calories, carbs, fat | ≤ 5 % over             | 15 % over        | ≥ 25 % over      |
| Protein              | ≤ 25 % over            | 50 % over        | ≥ 75 % over      |

- Protein is lenient: for an athlete it is a floor more than a ceiling, and its extra calories already show on the
  calorie bar.
- Past the tolerance the bar is labelled "+N kcal over" / "+Ng over" in the same colour (not colour alone); the lime
  glow is kept for an on-target bar.
- The tolerances are display constants (`OVER_TARGET_SCALE`, `PROTEIN_OVER_TARGET_SCALE`), not training rules.
- Yellow is its own colour, never gold: gold stays for PRs and goals.

### 3.2 Steps trend (Progress)

Progress charts daily steps (a dot per day, a dot per week past ~a year) with a **trend line**: the same descending
weighted 7-day average as bodyweight (§4.1), with days without a count skipped and their weight removed from the
divisor. Today's count is still in progress, so it is plotted but joins the trend only once the day is done. The step
target is drawn as a neutral dashed reference line. The chart follows the same range toggle as the bodyweight and
energy charts, and needs counts on at least two days.

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
_provisional_), blends a starting estimate with the measured value as data accrues, and turns the ramp-up
into milestones (first weigh-in → averages online → first TDEE → calibrated).

### 4.6 Weekly check-in card

Smoothed TDEE, actual vs target rate, adherence (each day's calories against the target that day showed, within
±10%), and next week's recommended calories & macros.

## 5. Goals

- Goal weight with projected date range.
- Strength targets per lift (e.g. Deadlift 600). A target is hit by a max entry at or above it dated on/after the day
  the target was set — never by a _correction_ alone.
- PR tracking (max increases, AMRAP rep PRs, benchmark metcon bests).
- A **max PR** is a manual or AMRAP max at least **1 lb** above every earlier max of that lift (initial entries only
  set the baseline). Re-entering a lift's max within **10 minutes** of the previous entry is a _correction_: it
  replaces that entry (a typo never becomes a PR or a high-water mark), is compared against the history before it, and
  keeps the corrected entry's achievement so a fix is never celebrated twice.
- Entries are ordered by when they were made on the device: an edit made offline carries its own time (the server
  trusts it within the last 30 days), so a backlog sent in one burst never reads as a string of quick corrections.
- A max can also be recorded explicitly as a **correction** (source `correction`, e.g. fixing a typo days later). It
  becomes the lift's current max like any newer entry, is **never** celebrated as a PR, and _resets_ the high-water mark:
  later PRs are measured against the corrected value, not the mistake it fixes. (A correction entered within 10
  minutes of the previous entry replaces that entry, as above, and stays a correction.)
- An **AMRAP rep PR** is a completed AMRAP set with more reps than every earlier AMRAP set of the same lift at the same
  or a heavier load. The first AMRAP at a load only sets the baseline; one per lift per session (its best set). Shown
  as "Bench press rep PR · 11 @ 200 lb".
- **Benchmark metcons** are matched by name ignoring case and spacing ("fran" = "Fran "). Scores are free text and
  parsed where possible:

  | Score               | Kind                      | Better |
  | ------------------- | ------------------------- | ------ |
  | `3:45`, `1:02:03`   | time                      | lower  |
  | `12+4`, `12 rounds` | rounds + reps             | higher |
  | `225 lb`, `100 kg`  | load (kg converted to lb) | higher |
  | `150`, `150 reps`   | reps                      | higher |

  A finished time beats a rounds or reps score (capped); other mixed kinds aren't compared. Each kind keeps its own
  best, so one oddly scored day (a load logged for Fran) never blocks later PRs. A parseable score that beats every
  comparable earlier best is a **benchmark PR** ("Fran PR · 3:45 · previous 4:02", previous = the best it beat, of its
  own kind when there is one); a result with nothing comparable before it only sets the baseline. The metcon editor
  shows the previous best.

## 6. Lifting

### 6.1 Tracked maxes

Back squat, front squat, deadlift, bench press, strict press (front squat tracked only, not currently
programmed). Maxes can be **edited manually at any time**; every change is recorded with date, source and
optional note.

### 6.2 Main lift calculation

- N-rep max = recorded max × rep-max % (editable table):

  | Reps | 1   | 2   | 3   | 4   | 5   | 6   | 8   | 10  | 12  |
  | ---- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
  | %    | 100 | 95  | 93  | 90  | 87  | 85  | 80  | 75  | 70  |

  (gaps are interpolated)

- Working weight for a set of N reps = **90% of the N-rep max**, rounded to the nearest **5 lb**.
- 4 sets, ascending reps / descending weight. Five-week cycle:

  | Week | Reps                                                                    |
  | ---- | ----------------------------------------------------------------------- |
  | 1    | 6 / 8 / 10 / 12                                                         |
  | 2    | 5 / 6 / 8 / 10                                                          |
  | 3    | 4 / 5 / 6 / 8                                                           |
  | 4    | 3 / 4 / 5 / 6                                                           |
  | 5    | Deload: 4×10 @ 90% of the 12-rep max; accessories same reps @ ~80% load |

  Worked example (max 555, week 4): 3 @ 465, 4 @ 450, 5 @ 435, 6+ @ 425.

### 6.3 AMRAP progression (optional rule, on by default)

- The **last set of the main lift** is AMRAP, except on deload weeks and on days with progression off
  (e.g. the carry day).
- Each rep beyond target adds **+1 lb** to the max (6 prescribed, 9 achieved → +3 lb).
- Applies **immediately**, as a one-tap suggestion the user confirms.

### 6.4 Weekly layout (current)

| Day | Focus          | Main lift                                              |
| --- | -------------- | ------------------------------------------------------ |
| Mon | Push           | Bench press                                            |
| Tue | Pull           | Deadlift                                               |
| Wed | Legs           | Back squat                                             |
| Thu | Push           | Strict press                                           |
| Fri | Carries & pull | — (sandbag cleans/carries, farmer's carries, pull-ups) |

### 6.5 Accessories & supersets

- Exercises and their sets can be grouped into **supersets** (covers core couplets and any pairing).
- Sets measure reps, seconds or distance. Independently, an exercise is **weighted** (tracks a load in lb) or not, so
  every combination exists: reps + load (rows, curls), time + load (weighted dead hang, weighted plank), distance + load
  (farmer's / sandbag carry), and unloaded reps, time or distance (pull-ups, a plank, a run). The flag is chosen when the
  exercise is created (Load: "Weighted" / "Unweighted") and can be changed later (**Edit exercise**, below). Until the athlete
  picks, the default follows the choices above it: weighted for reps (except core and conditioning) and for carries,
  unweighted otherwise. Main lifts (barbell category or tracking a max) are always weighted and offer no choice. An
  exercise created without saying (older clients, imports of backups from before the flag) is weighted. Seeds: the main
  lifts and the carries are weighted, pull-ups are not. On upgrade, existing exercises that were never logged or
  planned with a load (and aren't main lifts, max-tracked or strength targets) became unweighted, once.
  - A weighted exercise shows its load on every set (an empty "– lb" while none is set) and offers a load in the set
    editor. An unweighted one shows no load and no load control — except on a set already logged with a load (e.g.
    before the exercise was made unweighted), which keeps showing it and stays editable.
  - Whether an exercise is weighted is read from the exercise, not stored in sessions, so changing it applies at once,
    including to the session in progress. For an unweighted exercise, target loads on sets not yet logged are ignored
    (not shown, not counted; logging such a set records no load) but kept, so making it weighted again brings them
    back; loads already logged stay as data. An unweighted exercise's pre-filled and added sets carry no load.
  - One tap logs a set at its targets — except a set of a weighted accessory with no load yet (none entered or
    targeted), which opens the set editor instead, so a weighted set is never logged without a load by accident.
  - Volume counts weight × reps of rep-measured sets only; time and distance never count. A set's load is the one it
    was logged with (never a target it still holds), so a set logged without a load adds 0.
- **Edit exercise:** every exercise can be edited — from its row in Settings → Exercise library, or from its options in a
  session — with the create card's controls: name, category, measure ("Measured in"), load (not offered on a main lift,
  which is always weighted; making an exercise a main lift turns its load on) and max tracking; it can also be
  archived (with Undo) or restored. Saving sends only the fields that changed, as one patch, so edits of different
  fields from two devices both survive. A lift a program day calculates as its main lift keeps its category, measure
  and max tracking and can't be archived (the sheet says which days use it; change the weekly layout first); only its
  name is free. A lift with a strength target keeps tracking its max.
  - **Changing the measure** never rewrites history: each session keeps the measure its sets were done in (it is
    stored with the session's exercise), so past sessions, their volume and PRs read as they were done. From then on
    the exercise's current measure rules: when next week's pre-fill, an exercise added by hand or a skipped exercise
    carries from a performance in another measure, the set count carries (and the loads, if weighted, scaled as
    usual) but every target resets to the new measure's default (10 reps, 30 seconds, 40 meters); progression hints
    pass over performances in another measure. A saved session from today on that isn't completed follows at once
    where the exercise has nothing logged yet (new measure, targets reset, loads kept); where a set is already logged
    it keeps the old measure.
- Sessions pre-fill from the last session of the same day type (exercises, sets, target reps, last weights). Reps
  carry over as **targets** — a missed rep never becomes next week's target (sets added without a target carry what was
  done). On deload weeks accessory loads pre-fill at 80% — for weighted holds and carries too; deload loads never carry
  into a normal week (a normal week pre-fills from the last normal performance, or scales a deload-only one back up).
  An exercise added to a session by hand pre-fills the same way from the last time it was done as an accessory (never
  skipped, a normal week before a deload one, targets not missed reps, loads scaled to the session's week); one never
  done starts at three sets of 10 reps, 30 seconds or 40 meters.
- **Skip today:** an accessory can be marked skipped for one session. It stays in the session (and in next week's
  pre-fill, un-skipped, with the numbers from the last time it was actually done), but its sets don't count toward
  volume, PRs or hints.
- **Skip the main lift** (e.g. an injury): the main-lift block is marked skipped for that session. Its sets count toward
  nothing (set counts, volume, AMRAP PRs — not even as a baseline), so the session can be finished without being asked
  about unlogged sets. Skipping isn't a plan change.
- **Do this session today:** any upcoming day's plan (e.g. tomorrow's, for travel or a rest-day Sunday) can be done
  today: its main lift for that program day and week plus the accessories carried into it, under its own label, saved
  under today's date with `plannedFor` = the source day. Pre-fill, the plan-changed check and recalculation follow the
  source day (a Monday plan done on a Sunday is a Monday session for next Monday's pre-fill), and that day no longer
  shows as the next session. Once the moved session is completed the source day's plan counts as done: its checklist
  lift is ticked ("done Sun"), its streak day can close, the weekly check-in counts it, and the cycle it belongs to is
  credited (by `plannedFor`). The day holding the moved session expects that lift too, even on a rest day. The source
  day can still hold a session of its own.
- **Next session:** the next program day after today (looking 14 days ahead), with its label, main lift and week.
- **Plan changed:** a saved session nothing has been logged in yet is flagged when the program now prescribes something
  different for its main lift than when the session was built (lift, week, deload, reps, AMRAP flags, target weights —
  stored with the session as its plan signature), with a one-tap recalculation. The athlete's own edits to targets never
  read as a plan change. (Sessions saved before signatures existed compare their sets with a fresh plan instead; added
  back-off sets are ignored.)
- **Progression hint:** when every logged set of a weighted accessory's last (non-skipped, non-deload) performance with a
  load met that session's target — reps, seconds or meters — with a load, the next session suggests that load + **5 lb**
  (editable; 0 turns hints off): "All reps / Full duration / Full distance at 50 lb on Nov 2 → +5 lb". When a set fell
  short of its target, the hint says **hold** at the same load ("Missed reps at 50 lb on Nov 2 — hold", "Short on
  duration …", "Short on distance …"). A performance logged without any load (while the exercise was unweighted) is
  passed over for the one before it; one where only some sets had a load gives no hint. Unweighted exercises get no hint.
- Rest timer (targets editable: **180 s** after main-lift sets, **90 s** after accessories); plate calculator.

## 7. Gamification & feedback

- **Close the day**: today's checklist (weigh-in, nutrition, steps target, zone 2, metcon, lift as
  scheduled or moved — see "Do this session today") — closing every item extends the streak.
- Streaks, PR moments, cycle completions, calibration milestones, strength-target hits, goal weight.
- Each achievement is celebrated once. A max gain the screen already showed (applying an AMRAP bump) is filed as seen
  in the same step that saves it, so no full-screen celebration follows it — whether the save is confirmed at once or
  only after the device comes back online.
- Rule-based insights (protein adherence, sleep, HRV trend, steps, rate-of-change safety).
- Tasteful motion: smooth fills, a satisfying check, a restrained glow for PRs. Haptics where available.
- Optional **high-contrast "outdoor" mode** (brighter secondary text, thicker chart lines) for gym glare.

## 8. Platform

- TypeScript; React + Vite (installable PWA) frontend; Hono API on Node; Drizzle ORM.
- Postgres (Heroku Postgres in production).
- One Docker image (API + static frontend), deployed to Heroku's container stack.
- Single-user password auth with a long-lived signed session cookie that renews while in use. Signing out signs
  every device out (and asks the browser to clear its cache); changing the password does too, and so does restoring an
  export — into any database, fresh or not (the signing key includes a per-database salt that a restore replaces).
  Failed sign-ins are limited per network (/24, /64); under a distributed attack unknown devices are slowed down while
  devices that have signed in before ("known devices") sign in as usual.
- Offline-first: every edit is stored on the device and replayed in order until the server confirms it. Creates carry
  an `Idempotency-Key`, so a retry after a lost response never duplicates a row (keys are kept 7 days). Settings shows
  when the device last synced, what is still unsynced, and "Sync now"; Today marks rows with unsynced edits and ticks
  "saved" when the server confirms one. The data set is never kept in the browser's HTTP cache; the app revalidates its
  own copy with an ETag (304 when nothing changed). Every write answers with the data set's version just before and after
  it — exactly, whatever else is writing at the same time — so a device whose copy was current stays current after its
  own edits (the next revalidation is a 304), and one that missed another write never mistakes it for current. After
  onboarding the app asks the browser for persistent storage so the offline copy isn't evicted.
- Exercise creates and the `weighted` flag (§6.5), with windows of different app versions sharing one queue: a weighted
  create is sent without the flag (absent = weighted, as servers before it accept), and the flag doesn't count toward a
  create's idempotency check, so one sent by an older window (which drops it) and retried by a newer one replays. When
  that saved an unweighted create as weighted, the next current window patches it back. Exercise edits are patches of
  the changed fields only: edits queued offline merge field by field (the later value of a field wins), and the server
  sets only the fields a patch names, so another device's edit of a different field survives. Exports are version 3
  (exercises carry `weighted`); older ones restore every exercise as weighted. Migration 0006 turned the flag off once
  for existing exercises with no sign of a load (not main lifts or max-tracked, no max entry, strength target, program
  day or logged/planned load).
- Edits the server would reject (limits a person can hit: too many sets, an overlong note…) are refused before they are
  queued; Settings → Sync lists the last 20 with why, until cleared.
- **Version-checked saves.** Workouts and settings are saved as whole documents, each with a server revision. An edit
  carries the revision it was made on; when another device saved the document since, the server answers 409 with its
  copy and the edit is merged onto it and sent once more ("Merged changes from another device"):
  - workouts merge per set (by id; two sessions built separately on two devices are paired up main lift to main lift,
    accessory blocks by their exercises, sets in order): a set logged or edited on this device wins; sets and blocks only
    the other device has are kept; something one device removed stays removed unless the other changed it; the
    workout's own fields (notes, finish, skip) merge like settings;
  - exercises are matched by the sets they hold (not their position), so splitting or joining a superset on one device
    while the other logs never duplicates an exercise or a set; a set added on both devices keeps both;
  - if the merge leaves two main lifts (a session rebuilt on one device), the one matching the session's plan is kept and
    the other's logged sets are folded onto it (same lift) or kept as an accessory block (different lift) — logged work
    is never dropped;
  - a merged workout over the server's limits (30 sets, 6 per superset, 30 blocks) is trimmed of unlogged work; if logged
    work alone is over a limit, the edit is marked "not saved" with the reason;
  - settings merge field by field: the fields this device changed, the server's for everything else; strength targets
    merge by id, the weekday schedules and program weeks element by element; for other lists both devices changed, this
    device's wins and the toast names it;
  - edits made while a conflicting save was in flight are re-merged onto the merged copy (never sent over it); every 409
    teaches the device the server's current copy and revision;
  - a second conflict in a row keeps the merged copy and marks the edit "not saved" (Retry merges again); saves without
    a revision (older app versions) are accepted as before;
  - deleting a workout carries the revision too: when another device changed it since, the delete is refused and that
    device's copy is kept ("…changed on another device, so it wasn't deleted"); a create then delete that never reached
    the server sends nothing; a workout "new" on two devices at once is saved by the first, and the second merges onto it.
- **Forget this device** signs only this device out — its session is revoked on the server too, so a copy of the cookie
  stops working — drops its known-device mark (it's treated like any unknown device at sign-in) and wipes everything the
  app stored on it, after sending what it can (it keeps going while changes get through, shows how many remain, and
  reports how many unsynced changes were discarded).
- Pure, unit-tested domain modules for all calculations.
