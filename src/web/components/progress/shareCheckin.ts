import { formatShortDate, type ISODate } from "../../../shared/dates";
import type { WeeklyCheckin } from "../../../shared/insights";
import type { Vo2Trend } from "../../../shared/recovery";
import { fmt, minutesToHM, signed } from "../../lib/format";
import { formatProjectedRange } from "../projection";

/**
 * The weekly check-in as plain text for sharing (a message, a coach, a note): only what the
 * check-in on Progress shows, one short line per group, no names or account details.
 *
 *   Strawvine check-in · Oct 26 – Nov 1
 *   TDEE 2,850 kcal · trend 201.3 lb (−0.8 this week, plan −1.0)
 *   Intake 2,310 kcal avg · 5/7 days on target · protein 188 g
 *   Steps 9,820 avg · sleep 7h 20m · HRV 52 ms · resting HR 48 bpm
 *   VO2 max 52.3 (+1.2 since Oct 2)
 *   Lifts 3/4 · Metcon 2/3 · Zone 2 1/2
 *   Next week 2,400 kcal/day · P 200 · C 220 · F 70
 *   Goal 185 lb projected Dec 19 – Jan 8, 2027
 */
export function checkinText(c: WeeklyCheckin, opts: { today: ISODate; goalLb?: number | null }): string {
  const lines: string[] = [`Strawvine check-in · ${formatShortDate(c.from)} – ${formatShortDate(c.to)}`];
  const join = (parts: Array<string | null | false>) => parts.filter(Boolean).join(" · ");

  const change =
    c.weightChangeLb !== null
      ? ` (${signed(c.weightChangeLb, 1)} this week${c.targetRateLbPerWeek ? `, plan ${signed(c.targetRateLbPerWeek, 1)}` : ""})`
      : "";
  lines.push(join([c.tdee && `TDEE ${fmt(c.tdee.value)} kcal`, c.trendWeight !== null && `trend ${fmt(c.trendWeight, 1)} lb${change}`]));

  lines.push(
    join([
      c.avgCalories !== null && `Intake ${fmt(c.avgCalories)} kcal avg`,
      c.calorieAdherence !== null ? `${Math.round(c.calorieAdherence * 100)}% of days on target` : `${c.daysLogged}/7 days logged`,
      c.avgProtein !== null && `protein ${fmt(c.avgProtein)} g`,
    ]),
  );
  lines.push(
    join([
      c.avgSteps !== null && `Steps ${fmt(c.avgSteps)} avg`,
      c.avgSleepMinutes !== null && `sleep ${minutesToHM(c.avgSleepMinutes)}`,
      c.avgHrv !== null && `HRV ${fmt(c.avgHrv)} ms`,
      c.avgRestingHr != null && `resting HR ${fmt(c.avgRestingHr)} bpm`,
    ]),
  );
  // With a change, or from before the week (dated, so it doesn't read as this week's): in brackets.
  if (c.vo2Max)
    lines.push(`VO2 max ${fmt(c.vo2Max.value, 1)}${c.vo2Max.change !== null || !c.vo2Max.current ? ` (${vo2Change(c.vo2Max)})` : ""}`);
  // A group with nothing planned and nothing done (e.g. no lifting days set up) says nothing.
  const count = (name: string, v: { done: number; planned: number }) => (v.planned > 0 || v.done > 0) && `${name} ${v.done}/${v.planned}`;
  lines.push(join([count("Lifts", c.lifts), count("Metcon", c.metcon), count("Zone 2", c.zone2)]));
  if (c.next && c.daysLogged > 0)
    lines.push(
      `Next week ${fmt(c.next.calories)} kcal/day · P ${fmt(c.next.macros.proteinG)} · C ${fmt(c.next.macros.carbsG)} · F ${fmt(c.next.macros.fatG)}`,
    );
  if (c.projection?.range && opts.goalLb != null)
    lines.push(`Goal ${fmt(opts.goalLb, opts.goalLb % 1 ? 1 : 0)} lb projected ${formatProjectedRange(c.projection.range, opts.today)}`);
  return lines.filter(Boolean).join("\n");
}

/**
 * "+1.2 since Oct 2" — the VO2 max change over ~30 days; "as of Oct 30" without an earlier value to
 * compare with, or when the latest value is from before the check-in week (it isn't this week's).
 */
export function vo2Change(v: Vo2Trend): string {
  return v.current && v.change !== null && v.since
    ? `${signed(v.change, 1)} since ${formatShortDate(v.since)}`
    : `as of ${formatShortDate(v.date)}`;
}

export type ShareOutcome = "shared" | "copied" | "cancelled" | "failed";

/**
 * Shares `text` with the system share sheet where there is one, else copies it. A dismissed
 * share sheet is "cancelled" (nothing else happens); a share that fails falls back to copying.
 */
export async function shareText(text: string, title: string): Promise<ShareOutcome> {
  const nav = typeof navigator !== "undefined" ? navigator : undefined;
  if (nav?.share && (!nav.canShare || nav.canShare({ text, title }))) {
    try {
      await nav.share({ text, title });
      return "shared";
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return "cancelled";
      /* not allowed here (no user activation, insecure context…): copy instead */
    }
  }
  try {
    await nav!.clipboard.writeText(text);
    return "copied";
  } catch {
    return "failed";
  }
}
