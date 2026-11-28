/**
 * Golden check: every session without rehab or Core reads exactly as before chunk 2 (sections,
 * skips and rehab) — counts, volume, checklist, streaks, achievements, the weekly check-in and
 * insights, pre-fill, added exercises, hints, the plan-changed check, swap, structure edits and
 * Recalculate. See compute.ts: the expected answers were computed by the code before (b60f4e3,
 * generate.ts) over (1) the arguments of every call the existing suites made, recorded there, and
 * (2) seeded random worlds; the only intended difference, pre-fill's Core rule, is applied to the
 * old answers by `legacyCore`, so the new code must produce it on its own. Never regenerate
 * `expected.json.gz` from the current code.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { checklist } from "../gamify";
import { withRehabDraft } from "../rehab";
import type { DayLog, Session, Settings } from "../schemas";
import { daySections } from "../sections";
import {
  buildSession,
  isSessionStarted,
  isStrengthStarted,
  sessionCounts,
  sessionVolume,
  strengthCounts,
  strengthVolume,
  type BuildContext,
} from "../session";
import { normalizeSectionOrder } from "../sessionStructure";
import { recalculateMainLift } from "../swap";
import { addDays } from "../dates";
import { argsOf, hash, normalize, randomWorld, recordedSessions, run, worldCases, WORLD_START, WORLDS, type Pack } from "./compute";

const dir = fileURLToPath(new URL(".", import.meta.url));
const read = <T>(name: string) => JSON.parse(gunzipSync(readFileSync(`${dir}/${name}`)).toString()) as T;
const pack = read<Pack>("inputs.json.gz");
const expected = read<{ recorded: unknown[]; recalc: Array<unknown | null>; random: Record<string, string>; cases: number }>(
  "expected.json.gz",
);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

describe("golden: sessions without rehab or Core read as before", () => {
  it("replays every call the existing suites made, with the same answers", () => {
    expect(pack.calls.length).toBe(expected.recorded.length);
    expect(pack.calls.length).toBeGreaterThan(7000);
    const wrong: string[] = [];
    pack.calls.forEach(([fn, ref], i) => {
      const got = run(fn, argsOf(pack, ref), "new");
      if (!same(got, expected.recorded[i])) wrong.push(`#${i} ${fn}`);
    });
    expect(wrong).toEqual([]);
  }, 60_000);

  it("Recalculate keeps Train's recalculation (recorded sessions)", () => {
    let n = 0;
    pack.calls.forEach(([, ref], i) => {
      const want = expected.recalc[i];
      if (want == null) return;
      const [s, ctx] = argsOf(pack, ref) as [Session, BuildContext];
      const full = { ...ctx, sessions: ctx.sessions ?? [] };
      let got: unknown;
      try {
        got = normalize(recalculateMainLift(s, full), [s, full]);
      } catch (e) {
        got = { threw: String(e) };
      }
      expect(got, `#${i}`).toEqual(want);
      n++;
    });
    expect(n).toBeGreaterThan(200);
  }, 60_000);

  it(`reads ${WORLDS} random worlds the same (counts, pre-fill, checklist, achievements, insights, swap, structure)`, () => {
    let cases = 0;
    const wrong: string[] = [];
    for (let seed = 1; seed <= WORLDS; seed++) {
      const groups = new Map<string, unknown[]>();
      for (const c of worldCases(seed, "new")) {
        const key = `${seed}/${c.name.split("/").at(-1)}`;
        groups.set(key, [...(groups.get(key) ?? []), [c.name, c.out]]);
        cases++;
      }
      for (const [key, list] of groups) if (expected.random[key] !== hash(list)) wrong.push(key);
      for (const key of Object.keys(expected.random)) if (key.startsWith(`${seed}/`) && !groups.has(key)) wrong.push(`${key} (missing)`);
    }
    expect(wrong).toEqual([]);
    expect(cases).toBe(expected.cases);
    // Pre-fill's Core rule is exercised there: all-core blocks of the (legacy) templates land in Core.
    const w = randomWorld(1);
    const core = Array.from({ length: 63 }, (_, i) => buildSession(addDays(WORLD_START, i), w)).flatMap((s) =>
      s.blocks.filter((b) => b.section === "core"),
    );
    expect(core.length).toBeGreaterThan(0);
  }, 120_000);

  it("the new strength-only readings equal the old whole-session ones, and nothing is reordered or drafted", () => {
    const sessions = [...recordedSessions(pack), ...Array.from({ length: WORLDS }, (_, i) => randomWorld(i + 1).sessions).flat()];
    expect(sessions.length).toBeGreaterThan(1000);
    const settings = randomWorld(1).settings;
    for (const s of sessions) {
      expect(strengthCounts(s)).toEqual(sessionCounts(s));
      expect(isStrengthStarted(s)).toBe(isSessionStarted(s));
      expect(strengthVolume(s)).toBe(sessionVolume(s));
      if (s.blocks.every((b, i) => i === 0 || b.kind !== "primary")) expect(normalizeSectionOrder(s)).toBe(s);
      expect(withRehabDraft(s, { settings, sessions: [], exercises: [] })).toBe(s);
    }
  }, 60_000);

  it("each day's sections agree with its checklist (lift ⇔ strength finished, metcon, Zone 2)", () => {
    let days = 0;
    const check = (date: string, data: { settings: Settings; sessions: Session[]; days: DayLog[] }) => {
      const full = { ...data, exercises: [], maxEntries: [] };
      const sections = daySections(date, full, { today: "2099-01-01" });
      const day = data.days.findLast((d) => d.date === date);
      const own = data.sessions.findLast((s) => s.date === date);
      const early = data.sessions.filter((s) => s.plannedFor === date && s.date !== date);
      const doneEarly = early.find((s) => s.completedAt) ?? early.sort((a, b) => (a.date < b.date ? 1 : -1))[0] ?? null;
      for (const item of checklist(date, day, own, data.settings, { doneEarly })) {
        const key = item.key === "lift" ? "strength" : item.key;
        if (key !== "strength" && key !== "metcon" && key !== "zone2") continue;
        const section = sections.find((s) => s.key === key);
        expect(section, `${date} ${key}`).toBeDefined();
        expect(section!.status === "done", `${date} ${key}`).toBe(item.done);
      }
      days++;
    };
    for (let seed = 1; seed <= WORLDS; seed++) {
      const w = randomWorld(seed);
      for (const d of w.days) check(d.date, w);
    }
    for (const [fn, ref] of pack.calls) {
      if (fn !== "dayChecklist") continue;
      const [date, data] = argsOf(pack, ref) as [string, { settings: Settings; sessions: Session[]; days: DayLog[] }];
      check(date, data);
    }
    expect(days).toBeGreaterThan(2000);
  }, 60_000);
});
