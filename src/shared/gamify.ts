/**
 * Closing the day, streaks and achievements — all derived from raw data.
 */
import { addDays, dateRange, formatShortDate, weekdayOf, type ISODate } from "./dates";
import { CALIBRATION_DAYS, isLogged } from "./energy";
import { cyclePosition, programDayFor } from "./program";
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
  if (programDayFor(settings.program, date)) add("lift", "Lift", !!session?.completedAt);
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

export function closedDates(data: AppData, upTo: ISODate): Set<ISODate> {
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

export function achievements(data: AppData, today: ISODate): Achievement[] {
  const out: Achievement[] = [];
  const exName = (id: number) => data.exercises.find((e) => e.id === id)?.name ?? "Lift";

  // Calibration ramp-up.
  const logged = data.days.filter((d) => isLogged(d) && d.date <= today).map((d) => d.date).sort();
  const calib: Array<[number, string, string, string]> = [
    [1, "calib-1", "First entry", "Weight and calories logged. The engine is warming up."],
    [2, "calib-2", "First TDEE reading", "Two logged days — a first (rough) burn estimate."],
    [7, "calib-7", "Averages online", "A full week of weighted averages."],
    [CALIBRATION_DAYS, "calib-14", "Calibrated", "Your TDEE is now fully measured, not estimated."],
  ];
  for (const [n, key, title, detail] of calib) {
    const d = logged[n - 1];
    if (d) out.push({ key, title, detail, date: d, tier: "milestone" });
  }

  // Closed days & streaks.
  const closed = [...closedDates(data, today)].sort();
  if (closed[0]) out.push({ key: "close-1", title: "Day closed", detail: "Every box checked for the first time.", date: closed[0], tier: "streak" });
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

  // Max PRs (any increase over the previous recorded max, excluding initial entries).
  const byExercise = new Map<number, MaxEntry[]>();
  for (const e of data.maxEntries) {
    const list = byExercise.get(e.exerciseId) ?? [];
    list.push(e);
    byExercise.set(e.exerciseId, list);
  }
  for (const [exerciseId, list] of byExercise) {
    list.sort((a, b) => (a.date === b.date ? (a.createdAt < b.createdAt ? -1 : 1) : a.date < b.date ? -1 : 1));
    let best: number | null = null;
    for (const e of list) {
      if (best !== null && e.valueLb > best && e.source !== "initial") {
        const gain = Math.round((e.valueLb - best) * 10) / 10;
        out.push({
          key: `max-${e.id}`,
          title: `${exName(exerciseId)} ${e.valueLb}`,
          detail: `New max, +${gain} lb${e.source === "amrap" ? " from an AMRAP set" : ""}.`,
          date: e.date,
          tier: "pr",
        });
      }
      best = best === null ? e.valueLb : Math.max(best, e.valueLb);
    }
  }

  // Strength targets.
  for (const t of data.settings.strengthTargets) {
    const hit = (byExercise.get(t.exerciseId) ?? []).find((e) => e.valueLb >= t.targetLb && e.date >= t.setOn);
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
      out.push({ key: `cycle-${cycle}`, title: `Cycle ${cycle} complete`, detail: `${program.weeks.length} weeks banked.`, date: end, tier: "milestone" });

  // Lifetime volume & steps.
  const sessions = [...data.sessions].filter((s) => s.date <= today).sort((a, b) => (a.date < b.date ? -1 : 1));
  let volume = 0;
  let vi = 0;
  for (const s of sessions) {
    volume += sessionVolume(s);
    while (vi < VOLUME_TIERS.length && volume >= VOLUME_TIERS[vi]!) {
      out.push({ key: `volume-${VOLUME_TIERS[vi]}`, title: `${compact(VOLUME_TIERS[vi]!)} lb moved`, detail: "Lifetime training volume.", date: s.date, tier: "milestone" });
      vi++;
    }
  }
  const stepDays = [...data.days].filter((d) => d.steps && d.date <= today).sort((a, b) => (a.date < b.date ? -1 : 1));
  let steps = 0;
  let si = 0;
  for (const d of stepDays) {
    steps += d.steps ?? 0;
    while (si < STEP_TIERS.length && steps >= STEP_TIERS[si]!) {
      out.push({ key: `steps-${STEP_TIERS[si]}`, title: `${compact(STEP_TIERS[si]!)} steps`, detail: "Lifetime steps logged.", date: d.date, tier: "milestone" });
      si++;
    }
  }

  // Goal weight (raw weight reaching the target after the goal was set).
  const goal = data.settings.weightGoal;
  if (goal) {
    const startDay = data.days.filter((d) => d.weightLb !== null && d.date <= goal.setOn).sort((a, b) => (a.date < b.date ? 1 : -1))[0];
    const losing = startDay ? startDay.weightLb! > goal.targetLb : true;
    const hit = [...data.days]
      .filter((d) => d.weightLb !== null && d.date >= goal.setOn && d.date <= today)
      .sort((a, b) => (a.date < b.date ? -1 : 1))
      .find((d) => (losing ? d.weightLb! <= goal.targetLb : d.weightLb! >= goal.targetLb));
    if (hit)
      out.push({
        key: `goal-${goal.setOn}-${goal.targetLb}`,
        title: `Goal weight ${goal.targetLb}`,
        detail: `Reached on ${formatShortDate(hit.date)}.`,
        date: hit.date,
        tier: "goal",
      });
  }

  return out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

/** Days in a closed run ending today/yesterday, for heatmaps. */
export function recentDays(today: ISODate, n: number): ISODate[] {
  return dateRange(addDays(today, -(n - 1)), today);
}
