/**
 * The morning editor's resting HR and VO2 max, the Nutrition editor's "Also today" chips, and how
 * Today shows them (the Morning check-in and Nutrition rows of the checklist).
 */
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ChecklistItem } from "../../../shared/gamify";
import { emptyDayLog } from "../../../shared/empty";
import type { DayLog, DayLogPatch } from "../../../shared/schemas";
import { ToastProvider } from "../Toast";
import { DayChecklist } from "./Checklist";
import { FuelEditor, MorningEditor } from "./editors";

const DATE = "2026-11-03";

/** Renders an editor over a day that takes its own patches, recording each one. */
function harness(Editor: typeof MorningEditor, initial: Partial<DayLog> = {}) {
  const patches: DayLogPatch[] = [];
  function Harness() {
    const [day, setDay] = useState<DayLog>({ ...emptyDayLog(DATE), ...initial });
    return (
      <ToastProvider>
        <Editor
          day={day}
          patch={(p) => {
            patches.push(p);
            setDay((d) => ({ ...d, ...p }));
          }}
        />
      </ToastProvider>
    );
  }
  render(<Harness />);
  return patches;
}

describe("MorningEditor", () => {
  it("commits resting HR as a whole number and VO2 max with one decimal (saved as shown)", async () => {
    const user = userEvent.setup();
    const patches = harness(MorningEditor, { weightLb: 200 });
    const rhr = screen.getByRole("textbox", { name: "Resting HR" });
    await user.type(rhr, "47.6{Enter}");
    expect(patches.at(-1)).toEqual({ restingHrBpm: 48 });
    expect(rhr).toHaveProperty("value", "48");

    const vo2 = screen.getByRole("textbox", { name: "VO2 max" });
    await user.type(vo2, "52.34{Enter}");
    expect(patches.at(-1)).toEqual({ vo2Max: 52.3 });
    expect(vo2).toHaveProperty("value", "52.3");

    // Cleared back to not logged.
    await user.clear(vo2);
    await user.type(vo2, "{Enter}");
    expect(patches.at(-1)).toEqual({ vo2Max: null });
  });

  it("refuses readings out of range instead of clamping them to a believable limit", async () => {
    const user = userEvent.setup();
    const patches = harness(MorningEditor, { weightLb: 200, restingHrBpm: 48, vo2Max: 50, hrvMs: 60, sleepScore: 80 });
    const cases: Array<[string, string, string, string]> = [
      ["Resting HR", "5", "48", "20–220 bpm"],
      ["Resting HR", "400", "48", "20–220 bpm"],
      ["VO2 max", "520", "50", "10–100"],
      ["VO2 max", "5", "50", "10–100"],
      ["HRV", "900", "60", "0–500 ms"],
      ["Sleep score", "120", "80", "0–100"],
    ];
    for (const [name, typed, kept, range] of cases) {
      const input = screen.getByRole("textbox", { name });
      await user.clear(input);
      await user.type(input, `${typed}{Enter}`);
      expect(input, `${name} ${typed}`).toHaveProperty("value", kept);
      expect(input.getAttribute("aria-invalid")).toBe("true");
      const hint = document.getElementById(input.getAttribute("aria-describedby")!)!;
      expect(hint.textContent).toBe(`${name} not saved: use ${range}`);
      expect(hint.getAttribute("aria-live")).toBe("polite");
    }
    expect(patches).toEqual([]);

    // The next accepted entry saves and clears the hint.
    const rhr = screen.getByRole("textbox", { name: "Resting HR" });
    await user.clear(rhr);
    await user.type(rhr, "52{Enter}");
    expect(patches).toEqual([{ restingHrBpm: 52 }]);
    expect(rhr.getAttribute("aria-invalid")).toBeNull();
    expect(screen.queryByText("20–220 bpm", { exact: false })).toBeNull();
  });

  it("shows the units in the Resting HR and HRV boxes (VO2 max is named by its label alone)", () => {
    render(<MorningEditor day={{ ...emptyDayLog(DATE), hrvMs: 60, restingHrBpm: 48, vo2Max: 51 }} patch={() => {}} />);
    expect(screen.getByRole("textbox", { name: "Resting HR" }).closest("label")!.textContent).toBe("bpm");
    expect(screen.getByRole("textbox", { name: "HRV" }).closest("label")!.textContent).toBe("ms");
    expect(screen.getByRole("textbox", { name: "VO2 max" }).closest("label")!.textContent).toBe("");
  });

  it("shows blanks for a day cached without the fields (an older build's copy)", () => {
    const { restingHrBpm: _r, vo2Max: _v, ...legacy } = emptyDayLog(DATE);
    render(<MorningEditor day={legacy as DayLog} patch={() => {}} />);
    expect(screen.getByRole("textbox", { name: "Resting HR" })).toHaveProperty("value", "");
    expect(screen.getByRole("textbox", { name: "VO2 max" })).toHaveProperty("value", "");
  });
});

describe("Also today chips", () => {
  /** The chip's description: its state and what the next tap records. */
  const description = (chip: HTMLElement) => document.getElementById(chip.getAttribute("aria-describedby")!)!.textContent;

  it("cycle not recorded → none → had → not recorded: a fixed name, the state described, each change announced once", async () => {
    const user = userEvent.setup();
    const patches = harness(FuelEditor);
    const group = screen.getByRole("group", { name: "Also today" });
    const chips = within(group).getAllByRole("button");
    expect(chips.map((c) => c.getAttribute("aria-label"))).toEqual(["Alcohol", "Nicotine", "THC", "Caffeine"]);
    // Tri-state, not a pressed toggle (aria-pressed="mixed" would mean partly pressed).
    for (const c of chips) expect(c.hasAttribute("aria-pressed")).toBe(false);
    const status = screen.getByRole("status");
    expect(status.textContent).toBe("");

    const caffeine = chips[3]!;
    // Not recorded: grey, label only.
    expect(caffeine.className).toContain("bg-white/[0.05]");
    expect(within(caffeine).queryByText(/^(none|had)$/)).toBeNull();
    expect(description(caffeine)).toBe("not recorded · next tap: had none");

    // None: lime tint with the word "none" (the goal; first because it is the common tap). Spoken
    // "had none", never "none recorded" (one sound from "not recorded").
    await user.click(caffeine);
    expect(patches.at(-1)).toEqual({ caffeine: false });
    expect(screen.getByRole("button", { name: "Caffeine" })).toBe(caffeine);
    expect(caffeine.className).toContain("bg-accent/15");
    expect(caffeine.className).not.toContain("bg-warn/15");
    expect(within(caffeine).getByText("none").className).toContain("text-accent");
    expect(description(caffeine)).toBe("had none · next tap: had");
    expect(status.textContent).toBe("Caffeine: had none");

    // Had: coral tint with the word "had".
    await user.click(caffeine);
    expect(patches.at(-1)).toEqual({ caffeine: true });
    expect(screen.getByRole("button", { name: "Caffeine" })).toBe(caffeine);
    expect(caffeine.className).toContain("bg-warn/15");
    expect(caffeine.className).not.toContain("bg-accent/15");
    expect(within(caffeine).getByText("had").className).toContain("text-warn");
    expect(description(caffeine)).toBe("had · next tap: not recorded");
    expect(status.textContent).toBe("Caffeine: had");

    // Back to not recorded.
    await user.click(caffeine);
    expect(patches.at(-1)).toEqual({ caffeine: null });
    expect(caffeine.className).toContain("bg-white/[0.05]");
    expect(within(caffeine).queryByText(/^(none|had)$/)).toBeNull();
    expect(description(caffeine)).toBe("not recorded · next tap: had none");
    expect(status.textContent).toBe("Caffeine: not recorded");

    // The name never changed; nothing but the status region speaks the change.
    expect(chips.map((c) => c.getAttribute("aria-label"))).toEqual(["Alcohol", "Nicotine", "THC", "Caffeine"]);
    // (The macro fields' range hints are live regions too: empty unless a number is refused.)
    expect([...document.querySelectorAll("[aria-live]")].filter((el) => el.textContent)).toHaveLength(1);

    // Keyboard: Enter and Space cycle too. Each patch touches only its own flag.
    const thc = chips[2]!;
    thc.focus();
    await user.keyboard("{Enter}");
    await user.keyboard(" ");
    expect(description(thc)).toBe("had · next tap: not recorded");
    expect(patches).toEqual([{ caffeine: false }, { caffeine: true }, { caffeine: null }, { thc: false }, { thc: true }]);
    // 44px tap targets.
    for (const c of chips) expect(c.className).toContain("min-h-11");
  });

  it("show a day's recorded flags, and carry on the cycle from them", async () => {
    const user = userEvent.setup();
    const patches = harness(FuelEditor, { alcohol: false, nicotine: true });
    const group = screen.getByRole("group", { name: "Also today" });
    const alcohol = within(group).getByRole("button", { name: "Alcohol" });
    const nicotine = within(group).getByRole("button", { name: "Nicotine" });
    expect(description(alcohol)).toBe("had none · next tap: had");
    expect(description(nicotine)).toBe("had · next tap: not recorded");
    await user.click(alcohol);
    await user.click(nicotine);
    expect(patches).toEqual([{ alcohol: true }, { nicotine: null }]);
  });

  it("two clicks in one task advance two steps (each from the latest value, not the last render)", () => {
    const patches = harness(FuelEditor);
    const alcohol = screen.getByRole("button", { name: "Alcohol" });
    act(() => {
      alcohol.click();
      alcohol.click();
    });
    expect(patches).toEqual([{ alcohol: false }, { alcohol: true }]);
    expect(description(alcohol)).toBe("had · next tap: not recorded");
    expect(screen.getByRole("status").textContent).toBe("Alcohol: had");
    // And a third, after the render, carries on from there.
    act(() => alcohol.click());
    expect(patches.at(-1)).toEqual({ alcohol: null });
  });

  it("a day cached by an older build (no flags) shows them not recorded", async () => {
    const user = userEvent.setup();
    const { alcohol: _a, nicotine: _n, thc: _t, caffeine: _c, ...legacy } = emptyDayLog(DATE);
    const patches: DayLogPatch[] = [];
    render(
      <ToastProvider>
        <FuelEditor day={legacy as DayLog} patch={(p) => patches.push(p)} />
      </ToastProvider>,
    );
    const thc = screen.getByRole("button", { name: "THC" });
    expect(description(thc)).toBe("not recorded · next tap: had none");
    await user.click(thc);
    expect(patches).toEqual([{ thc: false }]);
  });
});

describe("Today's checklist: the Morning check-in row carries the recovery numbers", () => {
  const items: ChecklistItem[] = [
    { key: "morning", label: "Morning check-in", done: false, progress: 0 },
    { key: "fuel", label: "Nutrition", done: false, progress: 0 },
  ];
  const lift = { href: "/train", label: undefined, primaryName: null, setsDone: 0, setsTotal: 0 };
  const props = { items, patch: vi.fn(), stepTarget: 15000, zone2Minutes: 30, lift };
  const morning = () => screen.getByRole("button", { name: /^Morning check-in/ });
  const fuel = () => screen.getByRole("button", { name: /^Nutrition/ });
  /** The summary lines under the row's label, as shown (each is one truncating line). */
  const lines = (row: HTMLElement) => [...row.querySelectorAll(".truncate")].map((el) => el.textContent);

  it("prompts for what it holds while nothing is logged", () => {
    render(<DayChecklist {...props} day={emptyDayLog(DATE)} />);
    expect(lines(morning())).toEqual(["Weight · sleep · recovery"]);
    expect(lines(fuel())).toEqual(["Daily totals"]);
    // The weight alone is the row's value, and still leaves the prompt.
    expect(morning().textContent).not.toContain("lb");
  });

  it("with everything logged: the night's readings on one line, VO2 max and the ratings on the next", () => {
    render(
      <DayChecklist
        {...props}
        day={{
          ...emptyDayLog(DATE),
          weightLb: 197.8,
          sleepMinutes: 450,
          sleepScore: 81,
          hrvMs: 55,
          restingHrBpm: 48,
          vo2Max: 51.6,
          energy: 4,
          soreness: 2,
        }}
      />,
    );
    expect(lines(morning())).toEqual([
      "7h 30m · sleep score 81 · HRV 55 · RHRresting heart rate 48",
      "VO2 51.6 · energy 4/5 · soreness 2/5",
    ]);
    // The weight stays the row's right-hand value, beside the label.
    expect(morning().querySelector(".num")!.textContent).toBe("197.8 lb");
    // "RHR" on screen, "resting heart rate" for a screen reader (which spells the abbreviation out);
    // "score" alone on screen, "sleep score" read out.
    const rhr = within(morning()).getByText("RHR");
    expect(rhr.getAttribute("aria-hidden")).toBe("true");
    expect(rhr.nextElementSibling).toMatchObject({ className: "sr-only", textContent: "resting heart rate" });
    expect(within(morning()).getByText("sleep").className).toBe("sr-only");
    expect(screen.getByRole("button", { name: /sleep score 81 · HRV 55 · resting heart rate 48/ })).toBe(morning());
    expect(screen.getByRole("button", { name: /VO2 51.6 · energy 4\/5 · soreness 2\/5/ })).toBe(morning());
    // Neither closes the item: that is the weight's.
    expect(morning().textContent).toContain("not done");
  });

  it("shows only what was logged, on as few lines as it takes", () => {
    const { rerender } = render(<DayChecklist {...props} day={{ ...emptyDayLog(DATE), sleepMinutes: 432, hrvMs: 62 }} />);
    expect(lines(morning())).toEqual(["7h 12m · HRV 62"]);
    // Ratings alone take the first line.
    rerender(<DayChecklist {...props} day={{ ...emptyDayLog(DATE), energy: 3 }} />);
    expect(lines(morning())).toEqual(["energy 3/5"]);
    rerender(<DayChecklist {...props} day={{ ...emptyDayLog(DATE), sleepScore: 0, vo2Max: 52, soreness: 5 }} />);
    expect(lines(morning())).toEqual(["sleep score 0", "VO2 52.0 · soreness 5/5"]);
    rerender(<DayChecklist {...props} day={{ ...emptyDayLog(DATE), restingHrBpm: 48 }} />);
    expect(lines(morning())).toEqual(["RHRresting heart rate 48"]);
  });

  it("a day cached by an older build (newer fields undefined) shows what it has and nothing else", () => {
    const {
      restingHrBpm: _r,
      vo2Max: _v,
      energy: _e,
      soreness: _s,
      sleepScore: _sc,
      alcohol: _a,
      nicotine: _n,
      thc: _t,
      caffeine: _c,
      ...rest
    } = emptyDayLog(DATE);
    const { rerender } = render(<DayChecklist {...props} day={{ ...rest, hrvMs: 55, sleepMinutes: 450 } as DayLog} />);
    expect(lines(morning())).toEqual(["7h 30m · HRV 55"]);
    expect(morning().textContent).not.toMatch(/RHR|resting heart rate|VO2|energy|soreness|score|undefined|NaN/);
    expect(lines(fuel())).toEqual(["Daily totals"]);
    // With nothing at all, the prompt — not an empty line.
    rerender(<DayChecklist {...props} day={rest as DayLog} />);
    expect(lines(morning())).toEqual(["Weight · sleep · recovery"]);
  });

  it("a day from before sleep and HRV were logged (both undefined) shows the prompt, never 'NaNh' or 'HRV undefined'", () => {
    const { sleepMinutes: _sleep, hrvMs: _hrv, sleepScore: _score, ...older } = emptyDayLog(DATE);
    expect("sleepMinutes" in older || "hrvMs" in older).toBe(false);
    const { rerender } = render(<DayChecklist {...props} day={older as DayLog} />);
    expect(lines(morning())).toEqual(["Weight · sleep · recovery"]);
    expect(morning().textContent).not.toMatch(/HRV|NaN|undefined|\dh/);
    // With a weight (the row's value) and a rating, only those show.
    rerender(<DayChecklist {...props} day={{ ...older, weightLb: 201.2, energy: 2 } as DayLog} />);
    expect(lines(morning())).toEqual(["energy 2/5"]);
    expect(morning().querySelector(".num")!.textContent).toBe("201.2 lb");
    expect(morning().textContent).not.toMatch(/HRV|NaN|undefined|\dh/);
  });

  it("the prompt names what the row holds without singling out one reading: weight, sleep, recovery", () => {
    render(<DayChecklist {...props} day={emptyDayLog(DATE)} />);
    const prompt = lines(morning())[0]!;
    expect(prompt).toBe("Weight · sleep · recovery");
    expect(prompt).not.toMatch(/HRV/);
  });

  it("the Nutrition row still lists the Also today flags on a line of its own", () => {
    render(<DayChecklist {...props} day={{ ...emptyDayLog(DATE), caffeine: true, alcohol: true, nicotine: false }} />);
    expect(lines(fuel())).toEqual(["Daily totals", "Had alcohol and caffeine · No nicotine"]);
    expect(screen.getByRole("button", { name: /Had alcohol and caffeine · No nicotine/ })).toBe(fuel());
  });

  it("opens the morning editor from the row, named after it", async () => {
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <DayChecklist {...props} day={emptyDayLog(DATE)} />
      </ToastProvider>,
    );
    expect(morning().getAttribute("aria-expanded")).toBe("false");
    await user.click(morning());
    expect(morning().getAttribute("aria-expanded")).toBe("true");
    const panel = screen.getByRole("group", { name: "Morning check-in details" });
    expect(within(panel).getByRole("textbox", { name: "Morning weight" })).toBeTruthy();
    expect(within(panel).getByRole("radiogroup", { name: "Energy" })).toBeTruthy();
  });
});

describe("MorningEditor's 1–5 scales read as tappable and show the choice", () => {
  /** Each option's visible disc: its number and whether it is off, under the choice, or the choice. */
  const discs = (name: string) =>
    within(screen.getByRole("radiogroup", { name }))
      .getAllByRole("radio")
      .map((r) => {
        const disc = r.querySelector<HTMLElement>("[data-state]")!;
        return `${disc.textContent}:${disc.dataset.state}`;
      });

  it("shows five numbered buttons before anything is chosen", () => {
    harness(MorningEditor);
    expect(discs("Energy")).toEqual(["1:off", "2:off", "3:off", "4:off", "5:off"]);
    const radios = within(screen.getByRole("radiogroup", { name: "Soreness" })).getAllByRole("radio");
    expect(radios.map((r) => r.getAttribute("aria-checked"))).toEqual(["false", "false", "false", "false", "false"]);
    // 44px-tall targets; the ends say what 1 and 5 mean.
    for (const r of radios) expect(r.className).toContain("h-11");
    expect(screen.getByText("drained")).toBeTruthy();
    expect(screen.getByText("very sore")).toBeTruthy();
  });

  it("fills up to the chosen value, the choice itself solid; the values saved are the same 1–5", async () => {
    const user = userEvent.setup();
    const patches = harness(MorningEditor, { soreness: 2 });
    expect(discs("Soreness")).toEqual(["1:under", "2:chosen", "3:off", "4:off", "5:off"]);
    await user.click(screen.getByRole("radio", { name: "Energy 4 of 5" }));
    expect(patches).toEqual([{ energy: 4 }]);
    expect(discs("Energy")).toEqual(["1:under", "2:under", "3:under", "4:chosen", "5:off"]);
    expect(screen.getByRole("radio", { name: "Energy 4 of 5" }).getAttribute("aria-checked")).toBe("true");
    // Tapping the choice again clears it.
    await user.click(screen.getByRole("radio", { name: "Energy 4 of 5" }));
    expect(patches.at(-1)).toEqual({ energy: null });
    expect(discs("Energy")).toEqual(["1:off", "2:off", "3:off", "4:off", "5:off"]);
  });
});
