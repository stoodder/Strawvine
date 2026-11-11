/**
 * The one-line result of a done exercise (its folded row on Train): every measure, with and
 * without a load, sets that differ, sets logged without a load or a count, and the main lift's
 * AMRAP with its tag — and, over many generated exercises, that the line never states an amount
 * or a load a logged set doesn't have.
 */
import { describe, expect, it } from "vitest";
import type { Measure, SetEntry } from "../../../shared/schemas";
import { blankSet, logAtTargets, shownLoad } from "../../../shared/session";
import { exerciseSummary, SUMMARY_LIST_MAX, SUMMARY_PAIRS_MAX } from "./exerciseSummary";
import { accessorySetShown, mainSetValues } from "./SetControls";
import { mainSetTag, repScheme } from "./sessionEdit";

/** A logged set: `amount` reps (seconds, meters) at `load` lb. */
const done = (amount: number | null, load: number | null = null, more: Partial<SetEntry> = {}) =>
  blankSet({ done: true, reps: amount, targetReps: amount, weight: load, targetWeight: load, ...more });
const accessory = (sets: SetEntry[], measure: Measure = "reps", weighted = true) =>
  exerciseSummary({ sets, measure }, "accessory", weighted).text;
const main = (sets: SetEntry[]) => exerciseSummary({ sets, measure: "reps" }, "primary", true);

describe("exerciseSummary", () => {
  it("sets alike: sets × amount, then the load", () => {
    expect(accessory([done(8, 135), done(8, 135), done(8, 135)])).toBe("3 × 8 · 135 lb");
    expect(accessory([done(12, 27.5), done(12, 27.5)])).toBe("2 × 12 · 27.5 lb");
  });

  it("writes sets × amount the one way the screen does (`repScheme`, as the deload's plan in the main lift's header)", () => {
    expect(repScheme([10, 10, 10, 10])).toBe("4 × 10");
    expect(accessory([done(10, 135), done(10, 135), done(10, 135), done(10, 135)])).toBe(`${repScheme([10, 10, 10, 10])} · 135 lb`);
    expect(repScheme([6, 8, 10, 12])).toBe("6/8/10/12");
    expect(accessory([done(6, 50), done(8, 50), done(10, 50), done(12, 50)])).toBe(`${repScheme([6, 8, 10, 12])} · 50 lb`);
  });

  it("names the unit as a set's row does: reps only when no load follows, s and m always", () => {
    expect(accessory([done(10), done(10), done(10)], "reps", false)).toBe("3 × 10 reps");
    expect(accessory([done(1), done(1)], "reps", false)).toBe("2 × 1 rep");
    expect(accessory([done(30), done(30)], "seconds", false)).toBe("2 × 30 s");
    expect(accessory([done(30, 25), done(30, 25)], "seconds")).toBe("2 × 30 s · 25 lb");
    expect(accessory([done(40), done(40), done(40)], "meters", false)).toBe("3 × 40 m");
    expect(accessory([done(40, 70), done(40, 70), done(40, 70)], "meters")).toBe("3 × 40 m · 70 lb");
  });

  it("a single set is just what its row shows", () => {
    expect(accessory([done(12, 27.5)])).toBe("12 × 27.5 lb");
    expect(accessory([done(8)], "reps", false)).toBe("8 reps");
    expect(accessory([done(30, 25)], "seconds")).toBe("30 s · 25 lb");
    expect(accessory([done(40)], "meters", false)).toBe("40 m");
    // A weighted exercise's set logged without a load says so, as its row does.
    expect(accessory([done(10)])).toBe("10 × – lb (no load)");
    for (const [s, m, w] of [
      [done(12, 27.5), "reps", true],
      [done(30), "seconds", false],
      [done(40, 70), "meters", true],
    ] as const)
      expect(accessory([s], m, w)).toBe(accessorySetShown(s, m, w));
  });

  it("lists amounts that differ, set by set", () => {
    expect(accessory([done(8, 135), done(8, 135), done(6, 135)])).toBe("8/8/6 · 135 lb");
    expect(accessory([done(10), done(8), done(7)], "reps", false)).toBe("10/8/7 reps");
    expect(accessory([done(30, 25), done(20, 25)], "seconds")).toBe("30/20 s · 25 lb");
  });

  it("lists loads that differ, too", () => {
    expect(accessory([done(8, 125), done(8, 130), done(8, 135)])).toBe("3 × 8 · 125/130/135 lb");
    expect(accessory([done(8, 50), done(6, 55)])).toBe("8/6 · 50/55 lb");
    expect(accessory([done(40, 70), done(40, 90)], "meters")).toBe("2 × 40 m · 70/90 lb");
  });

  it("gives more than four differing sets as a range", () => {
    const sets = [done(10, 40), done(10, 45), done(8, 45), done(8, 50), done(6, 50)];
    expect(sets.length).toBe(SUMMARY_LIST_MAX + 1);
    expect(accessory(sets)).toBe("5 sets · 6–10 reps · 40–50 lb");
    expect(accessory([done(30), done(30), done(25), done(20), done(20)], "seconds", false)).toBe("5 sets · 20–30 s");
    // Four are still listed.
    expect(accessory(sets.slice(0, 4))).toBe("10/10/8/8 · 40/45/45/50 lb");
    // Five sets alike are still one "5 × 10".
    expect(accessory([1, 2, 3, 4, 5].map(() => done(10, 40)))).toBe("5 × 10 · 40 lb");
  });

  it("never gives a load to a set that has none: listed as “–”, and “up to” where a range would cover it", () => {
    // Four carries without a load and one at 10 lb is not five carries at 10 lb.
    const carries = [done(20), done(20), done(20), done(20), done(20, 10)];
    expect(accessory(carries, "meters", false)).toBe("5 × 20 m · up to 10 lb");
    expect(accessory(carries, "meters", false)).not.toContain("· 10 lb");
    // Differing loads, one set without: not "10–25 lb".
    expect(accessory([done(60), done(60, 25), done(60), done(58, 10), done(60), done(60)], "seconds", false)).toBe(
      "6 sets · 58–60 s · up to 25 lb",
    );
    // Up to four sets, each is listed.
    expect(accessory([done(10, 25), done(10)], "reps", false)).toBe("2 × 10 · 25/– lb");
    expect(accessory([done(10), done(10, 2.5), done(13), done(10)])).toBe("10/10/13/10 · –/2.5/–/– lb");
    // With every set loaded the range is a range.
    expect(accessory([done(20, 10), done(20, 10), done(20, 15), done(20, 15), done(20, 20)], "meters")).toBe("5 × 20 m · 10–20 lb");
  });

  it("a set logged at 0 lb has no load: it isn't shown as loaded", () => {
    expect(accessory([done(10, 0), done(10, 0)])).toBe("2 × 10 reps");
    expect(accessory([done(10, 0), done(10, 25)])).toBe("2 × 10 · –/25 lb");
    expect(accessory([done(30, 0), done(30, 0), done(30, 0)], "seconds")).toBe("3 × 30 s");
  });

  it("an unweighted exercise logs no load, whatever target its sets still hold", () => {
    expect(accessory([done(10, null, { targetWeight: 25 }), done(10, null, { targetWeight: 25 })], "reps", false)).toBe("2 × 10 reps");
  });

  it("counts what was done, not the target — a set logged without a count shows “–”, as its row does", () => {
    expect(accessory([done(8, 50, { targetReps: 10 }), done(7, 50, { targetReps: 10 })])).toBe("8/7 · 50 lb");
    // Not "2 × 10": only one of them was counted.
    expect(accessory([done(null, 50, { targetReps: 10 }), done(10, 50)])).toBe("–/10 · 50 lb");
    expect(accessory([done(null, 50, { targetReps: 10 }), done(null, 50, { targetReps: 10 })])).toBe("2 × – · 50 lb");
    // Too many to list: "up to", since "8–10 reps" would count the one that wasn't.
    expect(accessory([done(10), done(10), done(null, null, { targetReps: 10 }), done(8), done(8)], "reps", false)).toBe(
      "5 sets · up to 10 reps",
    );
  });

  it("leaves out sets not logged yet; nothing logged is no summary", () => {
    expect(accessory([done(8, 50), done(8, 50), blankSet({ targetReps: 8, targetWeight: 50 })])).toBe("2 × 8 · 50 lb");
    expect(exerciseSummary({ sets: [blankSet({ targetReps: 8 })], measure: "reps" }, "accessory", true)).toEqual({ parts: [], text: "" });
  });

  it("the main lift reads set by set, as its rows do (load × reps)", () => {
    const sets = [done(6, 170), done(8, 160)];
    const s = main(sets);
    expect(s.text).toBe("170 × 6 · 160 × 8");
    expect(s.parts).toEqual([{ text: "170 × 6" }, { text: "160 × 8" }]);
    expect(s.parts.map((p) => p.text)).toEqual(sets.map((x) => mainSetValues(x, null)));
    // A deload's sets are all alike: sets × reps, then the load.
    expect(main([done(10, 135), done(10, 135), done(10, 135), done(10, 135)]).text).toBe("4 × 10 · 135 lb");
    // Six are still listed; more than six: the range.
    const many = [6, 8, 10, 12, 12, 12, 12].map((r, i) => done(r, 170 - i * 5));
    expect(main(many.slice(0, SUMMARY_PAIRS_MAX)).parts).toHaveLength(SUMMARY_PAIRS_MAX);
    expect(main(many).text).toBe("7 sets · 6–12 reps · 140–170 lb");
  });

  it("carries the AMRAP's result with its own tag: gold over target, with the max bump once applied", () => {
    const sets = [done(6, 170), done(8, 160), done(10, 150)];
    const hit = main([...sets, done(12, 140, { amrap: true, targetReps: 12 })]);
    expect(hit.text).toBe("170 × 6 · 160 × 8 · 150 × 10 · 140 × 12 AMRAP");
    expect(hit.parts.at(-1)).toEqual({ text: "140 × 12", tag: { text: "AMRAP", tone: "accent" } });

    const over = main([...sets, done(14, 140, { amrap: true, targetReps: 12 })]);
    expect(over.text).toBe("170 × 6 · 160 × 8 · 150 × 10 · 140 × 14 +2 reps");
    expect(over.parts.at(-1)?.tag).toEqual({ text: "+2 reps", tone: "gold" });

    const applied = main([...sets, done(14, 140, { amrap: true, targetReps: 12, appliedProgressionLb: 2 })]);
    expect(applied.parts.at(-1)?.tag).toEqual({ text: "+2 reps · +2 lb", tone: "gold" });

    // A back-off set after the AMRAP: the tag stays with the AMRAP's pair, and "back-off" isn't a result.
    const backOff = main([...sets, done(14, 140, { amrap: true, targetReps: 12 }), done(10, 135)]);
    expect(backOff.text).toBe("170 × 6 · 160 × 8 · 150 × 10 · 140 × 14 +2 reps · 135 × 10");
    expect(backOff.parts.map((p) => !!p.tag)).toEqual([false, false, false, true, false]);

    // One set (the rest was skipped before it): its row, with its tag.
    expect(main([done(14, 140, { amrap: true, targetReps: 12 })]).text).toBe("140 × 14 +2 reps");
  });

  it("without pairs to hang it on, the line ends with the last AMRAP's tag", () => {
    // Two AMRAP sets at one load (sets alike in load: no pairs): the first hit its target, the last beat it.
    const first = done(12, 140, { amrap: true, targetReps: 12 });
    const last = done(15, 140, { amrap: true, targetReps: 12 });
    const s = main([first, last]);
    expect(s.text).toBe("12/15 · 140 lb +3 reps");
    expect(s.parts.at(-1)?.tag).toEqual(mainSetTag(last, false));
    expect(main([last, first]).parts.at(-1)?.tag).toEqual({ text: "AMRAP", tone: "accent" });
  });
});

describe("exerciseSummary never states what a logged set doesn't have", () => {
  // A small seeded generator (the same sequence on every run): exercises as the app logs them, and
  // wilder ones — sets logged without a count, without a load, at 0 lb, unweighted with a load.
  let seed = 20261111;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0), seed / 2 ** 32);
  const pick = <T>(xs: ReadonlyArray<T>) => xs[Math.floor(rnd() * xs.length)]!;
  const maybe = (p: number) => rnd() < p;
  const generate = () => {
    const kind = maybe(0.3) ? ("primary" as const) : ("accessory" as const);
    const measure: Measure = kind === "primary" ? "reps" : pick(["reps", "reps", "seconds", "meters"]);
    const weighted = kind === "primary" || maybe(0.6);
    const n = pick([1, 2, 3, 3, 4, 5, 6, 7, 10]);
    const baseAmount = measure === "reps" ? pick([1, 5, 8, 10, 12]) : measure === "seconds" ? pick([30, 45, 60]) : pick([20, 40, 100]);
    const baseLoad = weighted ? pick([0, 20, 22.5, 60, 135]) : null;
    const sets = Array.from({ length: n }, (_, i) => {
      let s = blankSet({
        targetReps: maybe(0.05) ? null : baseAmount + (kind === "primary" ? i * 2 : 0),
        targetWeight:
          baseLoad === null ? (maybe(0.2) ? 25 : null) : maybe(0.1) ? null : kind === "primary" && maybe(0.7) ? 225 - i * 10 : baseLoad,
        amrap: kind === "primary" && i === n - 1 && maybe(0.6),
      });
      if (maybe(0.1)) return s; // not logged
      s = logAtTargets(s, weighted);
      if (maybe(0.3)) s = { ...s, reps: Math.max(0, (s.reps ?? baseAmount) + pick([-2, -1, 1, 2, 3])) };
      if (weighted && maybe(0.2)) s = { ...s, weight: Math.max(0, (s.weight ?? 0) + pick([-5, 2.5, 5])) };
      if (!weighted && maybe(0.1)) s = { ...s, weight: pick([10, 25]) };
      if (maybe(0.08)) s = { ...s, reps: null };
      if (maybe(0.08)) s = { ...s, weight: pick([null, 0]) };
      return s;
    });
    return { sets, measure, kind, weighted };
  };
  const num = (t: string) => (t === "–" ? null : Number(t));
  const NUM = "(?:–|[\\d.]+)";

  it("over 20,000 generated exercises", () => {
    const seen = { single: 0, pairs: 0, alike: 0, listed: 0, ranged: 0, upTo: 0 };
    for (let run = 0; run < 20_000; run++) {
      const { sets, measure, kind, weighted } = generate();
      const logged = sets.filter((s) => s.done);
      const sum = exerciseSummary({ sets, measure }, kind, weighted);
      const say = `"${sum.text}" for [${logged.map((s) => `${s.reps}@${s.weight}`).join(", ")}] (${kind}, ${measure}, weighted=${weighted})`;
      expect(sum.text, say).toBe(sum.parts.map((p) => (p.tag ? `${p.text} ${p.tag.text}` : p.text)).join(" · "));
      expect(sum.text, say).not.toMatch(/NaN|undefined|null|Infinity/);
      if (!logged.length) {
        expect(sum, say).toEqual({ parts: [], text: "" });
        continue;
      }
      // What the rows show for the logged sets: the count logged, and a load only where there is one.
      const amounts = logged.map((s) => s.reps);
      const loads = logged.map((s) => shownLoad(s, weighted) || null);
      const texts = sum.parts.map((p) => p.text);
      // The AMRAP's tag is its row's — on its own pair, or (the last one's) at the end of the line.
      const tags = logged.map((s) => (s.amrap ? mainSetTag(s, false) : null));

      // One set, or the main lift set by set: the rows' own words.
      if (logged.length === 1) {
        seen.single++;
        expect(texts, say).toEqual([
          kind === "primary" ? mainSetValues(logged[0]!, null) : accessorySetShown(logged[0]!, measure, weighted),
        ]);
        expect(sum.parts[0]!.tag ?? null, say).toEqual(tags[0]);
        continue;
      }
      if (kind === "primary" && new Set(loads).size > 1 && logged.length <= SUMMARY_PAIRS_MAX) {
        seen.pairs++;
        expect(texts, say).toEqual(logged.map((s) => mainSetValues(s, null)));
        expect(
          sum.parts.map((p) => p.tag ?? null),
          say,
        ).toEqual(tags);
        continue;
      }
      expect(
        sum.parts.filter((p) => p.tag).map((p) => p.tag),
        say,
      ).toEqual(tags.filter((t) => t !== null).slice(-1));
      expect(
        sum.parts.findIndex((p) => p.tag),
        say,
      ).toBe(tags.some((t) => t !== null) ? sum.parts.length - 1 : -1);

      // The amounts: "n × a", "a/b/c", or "n sets · lo–hi" / "n sets · up to hi".
      const rest = [...texts];
      const first = rest.shift()!;
      let m: RegExpMatchArray | null;
      if ((m = first.match(new RegExp(`^(\\d+) × (${NUM})(?: (?:s|m|reps?))?$`)))) {
        seen.alike++;
        expect(Number(m[1]), say).toBe(logged.length);
        expect(amounts, say).toEqual(logged.map(() => num(m![2]!)));
      } else if ((m = first.match(new RegExp(`^(${NUM}(?:/${NUM})+)(?: (?:s|m|reps))?$`)))) {
        seen.listed++;
        expect(m[1]!.split("/").map(num), say).toEqual(amounts);
        expect(logged.length, say).toBeLessThanOrEqual(SUMMARY_LIST_MAX);
      } else {
        m = first.match(/^(\d+) sets$/);
        expect(m, say).not.toBeNull();
        expect(Number(m![1]), say).toBe(logged.length);
        const range = rest.shift()!;
        const have = amounts.filter((a): a is number => a !== null);
        const r = range.match(/^(?:up to ([\d.]+)|([\d.]+)–([\d.]+)) (?:s|m|reps)$/);
        expect(r, say).not.toBeNull();
        if (r![1] !== undefined) {
          seen.upTo++;
          // "up to": some set has no count, and none has more.
          expect(have.length, say).toBeLessThan(amounts.length);
          expect(Math.max(...have), say).toBe(Number(r![1]));
        } else {
          seen.ranged++;
          expect(have.length, say).toBe(amounts.length);
          expect([Math.min(...have), Math.max(...have)], say).toEqual([Number(r![2]), Number(r![3])]);
        }
      }
      // The unit is the measure's; the word "reps" only where no load follows.
      const unit = measure === "seconds" ? " s" : measure === "meters" ? " m" : null;
      if (unit)
        expect(
          [first, texts[1] ?? ""].some((t) => t.endsWith(unit)),
          say,
        ).toBe(true);

      // The load: none stated unless a set has one; one for all only if all have it; a range only if all have one.
      const load = rest.shift();
      expect(rest, say).toEqual([]);
      const have = loads.filter((l): l is number => l !== null);
      if (load === undefined) {
        expect(have, say).toEqual([]);
        continue;
      }
      expect(have.length, say).toBeGreaterThan(0);
      let l: RegExpMatchArray | null;
      if ((l = load.match(/^([\d.]+) lb$/))) expect(loads, say).toEqual(logged.map(() => Number(l![1])));
      else if ((l = load.match(new RegExp(`^(${NUM}(?:/${NUM})+) lb$`)))) expect(l[1]!.split("/").map(num), say).toEqual(loads);
      else if ((l = load.match(/^up to ([\d.]+) lb$/))) {
        seen.upTo++;
        expect(have.length, say).toBeLessThan(loads.length);
        expect(Math.max(...have), say).toBe(Number(l[1]));
      } else {
        l = load.match(/^([\d.]+)–([\d.]+) lb$/);
        expect(l, say).not.toBeNull();
        expect(have.length, say).toBe(loads.length);
        expect([Math.min(...have), Math.max(...have)], say).toEqual([Number(l![1]), Number(l![2])]);
      }
    }
    // Every shape of line came up, so every branch above was held to it.
    for (const [shape, count] of Object.entries(seen)) expect(count, shape).toBeGreaterThan(50);
  });
});
