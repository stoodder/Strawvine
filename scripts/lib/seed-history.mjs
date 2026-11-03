/**
 * A realistic multi-week history, written through the API: used by the e2e accessibility specs
 * (e2e/helpers.ts `seedHistory`) and scripts/contrast-audit.mjs, so screens are audited with
 * charts, trends, streaks, carried-over accessories and history rather than empty states.
 *
 * `call(method, path, body?)` sends one request to `/api…` with a signed-in session and resolves
 * with the parsed JSON (it must throw on a non-2xx answer).
 *
 * What it writes (ending the day before `through`'s cycle start, so Monday 2026-10-26 stays
 * week 1 of the first cycle):
 *   - `weeks` × 7 day logs ending at `through` (a missed day each week), with weight, calories,
 *     macros, micros, steps, sleep, HRV, resting HR, VO2 max, caffeine/alcohol flags, energy/soreness,
 *     zone 2, metcons (a benchmark repeated so it has a PR), journal entries;
 *   - completed sessions on the Mondays and Wednesdays before `through` (bench / squat + a
 *     pull-up accessory block), the last Monday's carried into the next one;
 *   - older max entries (and squat / deadlift maxes) and seen achievements left alone;
 *   - a weight goal and a strength target.
 */

const addDays = (iso, n) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const weekday = (iso) => new Date(`${iso}T00:00:00Z`).getUTCDay();

/**
 * @param {(method: string, path: string, body?: unknown) => Promise<any>} call
 * @param {{ through?: string, weeks?: number }} [opts]
 */
export async function seedHistory(call, { through = "2026-10-25", weeks = 3 } = {}) {
  const boot = await call("GET", "/api/bootstrap");
  const byName = (name) => {
    const e = boot.exercises.find((x) => x.name === name);
    if (!e) throw new Error(`seedHistory: no exercise named "${name}"`);
    return e;
  };
  const bench = byName("Bench press");
  const squat = byName("Back squat");
  const deadlift = byName("Deadlift");
  const pullUp = byName("Pull-up");

  const days = weeks * 7;
  const first = addDays(through, -(days - 1));
  for (let i = 0; i < days; i++) {
    const date = addDays(first, i);
    if (i % 7 === 4) continue; // a missed day each week
    const wd = weekday(date);
    await call("PUT", `/api/days/${date}`, {
      weightLb: Math.round((201.5 - i * 0.18 + ((i * 7) % 5) * 0.2) * 10) / 10,
      calories: 2250 + ((i * 37) % 5) * 60,
      proteinG: 185 + (i % 4) * 5,
      carbsG: 210 + (i % 3) * 15,
      fatG: 68 + (i % 2) * 6,
      micros: { fiberG: 30 + (i % 5), sodiumMg: 2300 + i * 10 },
      steps: 8000 + ((i * 1733) % 7000),
      sleepMinutes: 400 + ((i * 13) % 80),
      sleepScore: 70 + ((i * 7) % 25),
      hrvMs: 55 + ((i * 11) % 30),
      restingHrBpm: 46 + ((i * 5) % 7),
      vo2Max: Math.round((49.5 + i * 0.05) * 10) / 10,
      // "Also today": coffee most days, the odd drink; the rest not recorded.
      caffeine: i % 5 !== 0,
      alcohol: i % 7 === 5 ? true : i % 7 === 6 ? false : null,
      energy: 1 + (i % 5),
      soreness: 1 + ((i + 2) % 5),
      zone2Done: wd === 2 || wd === 4 || wd === 6,
      zone2Minutes: wd === 2 || wd === 4 || wd === 6 ? 35 + (i % 3) * 5 : null,
      ...(wd === 3 || wd === 5
        ? {
            metconDone: true,
            metconBenchmark: wd === 5 ? "Fran" : null,
            // Fran gets faster every week (the last one is a PR).
            metconScore: wd === 5 ? `${Math.max(3, 6 - Math.floor(i / 7))}:${String(10 + i).padStart(2, "0")}` : null,
            metconNotes: wd === 3 ? "EMOM 12: 10 burpees + 12 KB swings" : null,
          }
        : {}),
      ...(i % 6 === 1 ? { journal: `Week ${Math.floor(i / 7) + 1}: felt good, slept well.` } : {}),
    });
  }

  // Maxes: an older bench entry (the onboarding one stays current), squat and deadlift.
  await call("POST", `/api/exercises/${bench.id}/maxes`, { date: first, valueLb: 215, source: "manual", note: "last block" });
  await call("POST", `/api/exercises/${squat.id}/maxes`, { date: first, valueLb: 315, source: "manual", note: null });
  await call("POST", `/api/exercises/${deadlift.id}/maxes`, { date: first, valueLb: 405, source: "manual", note: null });

  // Sessions on the Mondays (bench) and Wednesdays (squat) of the seeded weeks.
  const set = (id, reps, weight, extra = {}) => ({
    id,
    targetReps: reps,
    targetWeight: weight,
    reps,
    weight,
    done: true,
    amrap: false,
    appliedProgressionLb: null,
    ...extra,
  });
  let n = 0;
  for (let i = 0; i < days; i++) {
    const date = addDays(first, i);
    const wd = weekday(date);
    if (wd !== 1 && wd !== 3) continue;
    const lift = wd === 1 ? bench : squat;
    const base = wd === 1 ? 175 + n * 2.5 : 245 + n * 5;
    n++;
    await call("PUT", `/api/sessions/${date}`, {
      date,
      label: wd === 1 ? "Push" : "Legs",
      cycle: null,
      week: null,
      deload: false,
      primaryMaxLb: wd === 1 ? 215 : 315,
      blocks: [
        {
          id: `p${i}`,
          kind: "primary",
          exercises: [
            {
              exerciseId: lift.id,
              measure: "reps",
              sets: [set(`p${i}a`, 5, base), set(`p${i}b`, 5, base), set(`p${i}c`, 5, base, { amrap: true, reps: 7 })],
            },
          ],
        },
        {
          id: `a${i}`,
          kind: "accessory",
          exercises: [{ exerciseId: pullUp.id, measure: "reps", sets: [set(`a${i}a`, 8, 0), set(`a${i}b`, 8, 0), set(`a${i}c`, 6, 0)] }],
        },
      ],
      notes: wd === 1 ? "Bar speed good." : "",
      completedAt: `${date}T18:30:00.000Z`,
      planSig: null,
    });
  }

  // Goals: a weight goal (cutting) and a strength target.
  const { settings } = await call("GET", "/api/bootstrap");
  await call("PUT", "/api/settings", {
    ...settings,
    weightGoal: { targetLb: 190, pacePctPerWeek: 0.75, setOn: first, startLb: 201.5 },
    strengthTargets: [...settings.strengthTargets, { id: "seed-bench-275", exerciseId: bench.id, targetLb: 275, setOn: first }],
  });
}
