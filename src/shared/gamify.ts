/**
 * Closing the day, streaks and achievements — all derived from raw data.
 */
import { benchmarkPrs } from "./benchmarks";
import { addDays, dateRange, formatShortDate, weekdayOf, type ISODate } from "./dates";
import { CALIBRATION_DAYS, firstTdeeDate, isLogged } from "./energy";
import { cyclePosition, scheduledProgramDay } from "./program";
import type { DayLog, Exercise, MaxEntry, Session, Settings } from "./schemas";
import { sessionVolume } from "./session";

export interface AppData {
  settings: Settings;
  days: ReadonlyArray<DayLog>;
  exercises: ReadonlyArray<Exercise>;
  maxEntries: ReadonlyArray<MaxEntry>;
  sessions: ReadonlyArray<Session>;
}

export type ChecklistKey = "morning" | "fuel" | "steps" | "zone2" | "metcon" | "lift";

export interface ChecklistItem {
  key: ChecklistKey;
  label: string;
  done: boolean;
  /** 0…1 partial progress where meaningful (steps). */
  progress: number;
}

export function checklist(date: ISODate, day: DayLog | undefined, session: Session | undefined, settings: Settings): ChecklistItem[] {
  const wd = weekdayOf(date);
  const items: ChecklistItem[] = [];
  const add = (key: ChecklistKey, label: string, done: boolean, progress = done ? 1 : 0) =>
    items.push({ key, label, done, progress: Math.max(0, Math.min(1, progress)) });

  add("morning", "Weigh-in", day?.weightLb != null);
  add("fuel", "Nutrition", day?.calories != null);
  const steps = day?.steps ?? 0;
  const stepTarget = settings.targets.steps;
  add("steps", "Steps", stepTarget > 0 ? steps >= stepTarget : day?.steps != null, stepTarget > 0 ? steps / stepTarget : 0);
  if (scheduledProgramDay(settings.program, date)) add("lift", "Lift", !!session?.completedAt);
  if (settings.schedule.metcon[wd]) add("metcon", "Metcon", !!day?.metconDone);
  if (settings.schedule.zone2[wd]) add("zone2", "Zone 2", !!day?.zone2Done);
  return items;
}

export function isClosed(items: ChecklistItem[]): boolean {
  return items.length > 0 && items.every((i) => i.done);
}

function indexData(data: AppData) {
  const days = new Map(data.days.map((d) => [d.date, d]));
  const sessions = new Map(data.sessions.map((s) => [s.date, s]));
  return { days, sessions };
}

/**
 * One-entry memo: the client derives streaks and achievements from the same (immutable) data
 * on every write, and both start from the closed days.
 */
let closedMemo: { days: AppData["days"]; sessions: AppData["sessions"]; settings: Settings; upTo: ISODate; result: Set<ISODate> } | null =
  null;

export function closedDates(data: AppData, upTo: ISODate): Set<ISODate> {
  const m = closedMemo;
  if (m && m.days === data.days && m.sessions === data.sessions && m.settings === data.settings && m.upTo === upTo)
    return new Set(m.result);
  const result = computeClosedDates(data, upTo);
  closedMemo = { days: data.days, sessions: data.sessions, settings: data.settings, upTo, result };
  return new Set(result);
}

function computeClosedDates(data: AppData, upTo: ISODate): Set<ISODate> {
  const { days, sessions } = indexData(data);
  const out = new Set<ISODate>();
  for (const [date, day] of days) {
    if (date > upTo) continue;
    if (isClosed(checklist(date, day, sessions.get(date), data.settings))) out.add(date);
  }
  return out;
}

export interface StreakInfo {
  current: number;
  best: number;
  /** Today is closed already. */
  todayClosed: boolean;
}

export function streaks(data: AppData, today: ISODate): StreakInfo {
  const closed = closedDates(data, today);
  const todayClosed = closed.has(today);
  let current = 0;
  // Today still in progress never breaks the streak.
  for (let d = todayClosed ? today : addDays(today, -1); closed.has(d); d = addDays(d, -1)) current++;
  let best = 0;
  let run = 0;
  const sorted = [...closed].sort();
  let prev: ISODate | null = null;
  for (const d of sorted) {
    run = prev && addDays(prev, 1) === d ? run + 1 : 1;
    best = Math.max(best, run);
    prev = d;
  }
  return { current, best, todayClosed };
}

// ---------------------------------------------------------------------------
// Achievements
// ---------------------------------------------------------------------------

export type AchievementTier = "milestone" | "streak" | "pr" | "goal";

export interface Achievement {
  key: string;
  title: string;
  detail: string;
  date: ISODate;
  tier: AchievementTier;
}

const STREAK_TIERS = [3, 7, 14, 30, 60, 100, 180, 365];
const VOLUME_TIERS = [100_000, 250_000, 500_000, 1_000_000, 2_500_000, 5_000_000, 10_000_000];
const STEP_TIERS = [1_000_000, 2_500_000, 5_000_000, 10_000_000];

function compact(n: number): string {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${+(n / 1000).toFixed(0)}k`;
  return String(n);
}

/** A manual entry this soon after the previous entry for the same lift edits it (a typo fix). */
export const MAX_CORRECTION_WINDOW_MS = 10 * 60_000;
/** Smallest increase over the previous best that counts as a PR. */
export const MIN_PR_GAIN_LB = 1;

export interface EffectiveMaxEntry extends MaxEntry {
  /** Id of the first entry in a chain of quick corrections (the entry itself when none). */
  rootId: number;
  /** This entry re-states the previous one (entered within MAX_CORRECTION_WINDOW_MS). */
  correction: boolean;
}

/**
 * Each lift's max history as the athlete meant it, sorted by date: a manual (or explicit
 * correction) entry made within MAX_CORRECTION_WINDOW_MS of the previous entry for the same lift
 * *replaces* it, so a typo (315 → 3150 → 315) is neither a PR nor a high-water mark later maxes
 * have to beat. Explicit `correction` entries outside the window stay in the history (see `maxPrs`).
 * Negative ids are the client's optimistic placeholders and are skipped: a PR is keyed (and
 * celebrated) once, by the saved row that replaces the placeholder.
 */
export function effectiveMaxHistory(entries: ReadonlyArray<MaxEntry>): Map<number, EffectiveMaxEntry[]> {
  const byExercise = new Map<number, MaxEntry[]>();
  for (const e of entries) {
    if (e.id < 0) continue;
    const list = byExercise.get(e.exerciseId) ?? [];
    list.push(e);
    byExercise.set(e.exerciseId, list);
  }
  const out = new Map<number, EffectiveMaxEntry[]>();
  for (const [exerciseId, list] of byExercise) {
    const created = (e: MaxEntry) => Date.parse(e.createdAt);
    const byCreation = [...list].sort((a, b) => created(a) - created(b) || a.id - b.id);
    const kept: EffectiveMaxEntry[] = [];
    for (const e of byCreation) {
      const prev = kept.at(-1);
      const gap = prev ? created(e) - created(prev) : NaN;
      if (prev && (e.source === "manual" || e.source === "correction") && gap >= 0 && gap <= MAX_CORRECTION_WINDOW_MS) {
        // Re-typing an explicit correction is still a correction.
        const source = prev.source === "correction" ? "correction" : e.source;
        kept[kept.length - 1] = { ...e, source, rootId: prev.rootId, correction: true };
      } else kept.push({ ...e, rootId: e.id, correction: false });
    }
    kept.sort((a, b) => (a.date === b.date ? (a.createdAt < b.createdAt ? -1 : 1) : a.date < b.date ? -1 : 1));
    out.set(exerciseId, kept);
  }
  return out;
}

export interface MaxPr {
  entry: EffectiveMaxEntry;
  gainLb: number;
  /** Stable id for the achievement key: corrections keep the key of the entry they fix. */
  keyId: number;
}

/**
 * PRs: a manual or AMRAP max at least MIN_PR_GAIN_LB above every earlier max of the lift.
 * Initial entries only set the baseline. A quick correction counts against the history before
 * the entry it fixes and keeps that entry's key, so fixing an already-celebrated PR doesn't
 * celebrate again — and fixing a typo'd *low* entry doesn't celebrate the "gain" from the typo.
 * An explicit `correction` entry is never a PR and *resets* the high-water mark to its value,
 * so later PRs are measured against the corrected max rather than the mistake it fixes.
 */
export function maxPrs(history: Map<number, ReadonlyArray<EffectiveMaxEntry>>): MaxPr[] {
  const out: MaxPr[] = [];
  for (const list of history.values()) {
    let best: number | null = null;
    for (const e of list) {
      if (e.source === "correction") {
        best = e.valueLb;
        continue;
      }
      if (best !== null && e.source !== "initial") {
        const gainLb = Math.round((e.valueLb - best) * 10) / 10;
        if (gainLb >= MIN_PR_GAIN_LB) out.push({ entry: e, gainLb, keyId: e.rootId });
      }
      best = best === null ? e.valueLb : Math.max(best, e.valueLb);
    }
  }
  return out;
}

export interface AmrapPr {
  /** `amrap-<date>-<exerciseId>`. */
  key: string;
  date: ISODate;
  exerciseId: number;
  reps: number;
  weightLb: number;
  /** The best earlier AMRAP at this load or heavier. */
  previousReps: number;
}

/**
 * AMRAP rep PRs: a completed AMRAP set with more reps than every earlier AMRAP set of the same
 * lift at the same or a heavier load (a first AMRAP at a load only sets the baseline). One per
 * lift per session — its best set. Skipped exercises and unsaved (temporary-id) lifts are ignored.
 */
export function amrapPrs(sessions: ReadonlyArray<Session>, upTo?: ISODate): AmrapPr[] {
  const sorted = sessions.filter((s) => !upTo || s.date <= upTo).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const history = new Map<number, Array<{ reps: number; weightLb: number }>>();
  const out: AmrapPr[] = [];
  for (const s of sorted) {
    const today = new Map<number, Array<{ reps: number; weightLb: number }>>();
    for (const b of s.blocks)
      for (const e of b.exercises) {
        if (e.skipped || e.exerciseId < 0) continue;
        for (const set of e.sets) {
          const weightLb = set.weight ?? set.targetWeight;
          if (!set.amrap || !set.done || set.reps === null || weightLb === null) continue;
          today.set(e.exerciseId, [...(today.get(e.exerciseId) ?? []), { reps: set.reps, weightLb }]);
        }
      }
    for (const [exerciseId, sets] of today) {
      const past = history.get(exerciseId) ?? [];
      let pr: AmrapPr | null = null;
      for (const set of sets) {
        const atOrAbove = past.filter((p) => p.weightLb >= set.weightLb);
        if (!atOrAbove.length) continue;
        const previousReps = Math.max(...atOrAbove.map((p) => p.reps));
        if (set.reps > previousReps && (!pr || set.reps > pr.reps || (set.reps === pr.reps && set.weightLb > pr.weightLb)))
          pr = { key: `amrap-${s.date}-${exerciseId}`, date: s.date, exerciseId, reps: set.reps, weightLb: set.weightLb, previousReps };
      }
      if (pr) out.push(pr);
      history.set(exerciseId, [...past, ...sets]);
    }
  }
  return out;
}

export function achievements(data: AppData, today: ISODate): Achievement[] {
  const out: Achievement[] = [];
  const exName = (id: number) => data.exercises.find((e) => e.id === id)?.name ?? "Lift";

  // Calibration ramp-up.
  const logged = data.days
    .filter((d) => isLogged(d) && d.date <= today)
    .map((d) => d.date)
    .sort();
  const calib: Array<[ISODate | null | undefined, string, string, string]> = [
    [logged[0], "calib-1", "First entry", "Weight and calories logged. The engine is warming up."],
    // Not simply the 2nd logged day: a TDEE needs another logged day within the week before.
    [firstTdeeDate(logged), "calib-2", "First TDEE reading", "Two logged days — a first (rough) burn estimate."],
    [logged[6], "calib-7", "Averages online", "A full week of weighted averages."],
    [logged[CALIBRATION_DAYS - 1], "calib-14", "Calibrated", "Your TDEE is now fully measured, not estimated."],
  ];
  for (const [d, key, title, detail] of calib) if (d) out.push({ key, title, detail, date: d, tier: "milestone" });

  // Closed days & streaks.
  const closed = [...closedDates(data, today)].sort();
  if (closed[0])
    out.push({ key: "close-1", title: "Day closed", detail: "Every box checked for the first time.", date: closed[0], tier: "streak" });
  let run = 0;
  let prev: ISODate | null = null;
  const reached = new Set<number>();
  for (const d of closed) {
    run = prev && addDays(prev, 1) === d ? run + 1 : 1;
    prev = d;
    for (const t of STREAK_TIERS)
      if (run === t && !reached.has(t)) {
        reached.add(t);
        out.push({ key: `streak-${t}`, title: `${t}-day streak`, detail: `${t} consecutive days closed.`, date: d, tier: "streak" });
      }
  }

  // Max PRs (see `maxPrs`).
  const byExercise = effectiveMaxHistory(data.maxEntries);
  for (const pr of maxPrs(byExercise)) {
    const { entry: e, gainLb } = pr;
    out.push({
      key: `max-${pr.keyId}`,
      title: `${exName(e.exerciseId)} ${e.valueLb}`,
      detail: `New max, +${gainLb} lb${e.source === "amrap" ? " from an AMRAP set" : ""}.`,
      date: e.date,
      tier: "pr",
    });
  }

  // AMRAP rep PRs (see `amrapPrs`).
  for (const pr of amrapPrs(data.sessions, today))
    out.push({
      key: pr.key,
      title: `${exName(pr.exerciseId)} rep PR`,
      detail: `${pr.reps} @ ${pr.weightLb} lb`,
      date: pr.date,
      tier: "pr",
    });

  // Benchmark metcon PRs (see `benchmarkPrs`).
  for (const pr of benchmarkPrs(data.days.filter((d) => d.date <= today)))
    out.push({
      key: pr.key,
      title: `${pr.entry.name} PR`,
      detail: `${pr.entry.score} · previous ${pr.previous.score}`,
      date: pr.entry.date,
      tier: "pr",
    });

  // Strength targets. A correction restates a max; it never hits a target by itself.
  for (const t of data.settings.strengthTargets) {
    const hit = (byExercise.get(t.exerciseId) ?? []).find((e) => e.source !== "correction" && e.valueLb >= t.targetLb && e.date >= t.setOn);
    if (hit)
      out.push({
        key: `target-${t.id}`,
        title: `${exName(t.exerciseId)} ${t.targetLb}`,
        detail: "Strength target reached.",
        date: hit.date,
        tier: "goal",
      });
  }

  // Completed cycles (at least one completed session in the cycle).
  const program = data.settings.program;
  const cyclesWithWork = new Map<number, ISODate>();
  for (const s of data.sessions) {
    if (!s.completedAt) continue;
    const pos = cyclePosition(program, s.date);
    if (pos) cyclesWithWork.set(pos.cycle, pos.cycleEnd);
  }
  for (const [cycle, end] of cyclesWithWork)
    if (end <= today)
      out.push({
        key: `cycle-${cycle}`,
        title: `Cycle ${cycle} complete`,
        detail: `${program.weeks.length} weeks banked.`,
        date: end,
        tier: "milestone",
      });

  // Lifetime volume & steps.
  const sessions = [...data.sessions].filter((s) => s.date <= today).sort((a, b) => (a.date < b.date ? -1 : 1));
  let volume = 0;
  let vi = 0;
  for (const s of sessions) {
    volume += sessionVolume(s);
    while (vi < VOLUME_TIERS.length && volume >= VOLUME_TIERS[vi]!) {
      out.push({
        key: `volume-${VOLUME_TIERS[vi]}`,
        title: `${compact(VOLUME_TIERS[vi]!)} lb moved`,
        detail: "Lifetime training volume.",
        date: s.date,
        tier: "milestone",
      });
      vi++;
    }
  }
  const stepDays = [...data.days].filter((d) => d.steps && d.date <= today).sort((a, b) => (a.date < b.date ? -1 : 1));
  let steps = 0;
  let si = 0;
  for (const d of stepDays) {
    steps += d.steps ?? 0;
    while (si < STEP_TIERS.length && steps >= STEP_TIERS[si]!) {
      out.push({
        key: `steps-${STEP_TIERS[si]}`,
        title: `${compact(STEP_TIERS[si]!)} steps`,
        detail: "Lifetime steps logged.",
        date: d.date,
        tier: "milestone",
      });
      si++;
    }
  }

  // Goal weight (raw weight reaching the target after the goal was set). The goal's direction
  // comes from the bodyweight it was set at: recorded with the goal, else the latest weigh-in
  // on/before it was set, else the first one after. Without any weigh-in there is no direction.
  const goal = data.settings.weightGoal;
  if (goal) {
    const weighIns = data.days
      .filter((d): d is DayLog & { weightLb: number } => d.weightLb !== null && d.date <= today)
      .sort((a, b) => (a.date < b.date ? -1 : 1));
    const startLb =
      goal.startLb ?? weighIns.findLast((d) => d.date <= goal.setOn)?.weightLb ?? weighIns.find((d) => d.date > goal.setOn)?.weightLb;
    if (startLb != null) {
      const losing = startLb > goal.targetLb;
      const hit = weighIns.find((d) => d.date >= goal.setOn && (losing ? d.weightLb <= goal.targetLb : d.weightLb >= goal.targetLb));
      if (hit)
        out.push({
          key: `goal-${goal.setOn}-${goal.targetLb}`,
          title: `Goal weight ${goal.targetLb}`,
          detail: `Reached on ${formatShortDate(hit.date)}.`,
          date: hit.date,
          tier: "goal",
        });
    }
  }

  return out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

/** Days in a closed run ending today/yesterday, for heatmaps. */
export function recentDays(today: ISODate, n: number): ISODate[] {
  return dateRange(addDays(today, -(n - 1)), today);
}
