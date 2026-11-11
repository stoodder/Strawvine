/**
 * The set row (main lift and accessories): two explicit controls — the values open the editor, the
 * check logs / unlogs — with the accessible names sets have always had, in every measure, with
 * and without a load, open and logged. (What the check does for an AMRAP or a weighted set
 * without a load is `checkAction`, below; the Train screen's own test drives it end to end.)
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { Measure, SetEntry } from "../../../shared/schemas";
import { AccessorySetRow, accessorySetShown, accessorySetValues, MainSetRow, mainSetTag, mainSetValues } from "./SetControls";
import { checkAction } from "./sessionEdit";

const root = () => document.getElementById("root")!;
const set = (o: Partial<SetEntry> = {}): SetEntry => ({
  id: "s1",
  targetReps: 8,
  targetWeight: null,
  reps: null,
  weight: null,
  done: false,
  amrap: false,
  appliedProgressionLb: null,
  ...o,
});
const logged = (o: Partial<SetEntry> = {}) => set({ done: true, reps: 8, ...o });

function accessory(s: SetEntry, measure: Measure, weighted: boolean, props: { needsLoad?: boolean } = {}) {
  const onCheck = vi.fn();
  const onEdit = vi.fn();
  render(
    <ul>
      <AccessorySetRow
        exerciseName="Pull-up"
        index={0}
        dataSet={s.id}
        set={s}
        measure={measure}
        weighted={weighted}
        onCheck={onCheck}
        onEdit={onEdit}
        {...props}
      />
    </ul>,
    { container: root() },
  );
  return { onCheck, onEdit };
}
function main(s: SetEntry, extra = false) {
  const onCheck = vi.fn();
  const onEdit = vi.fn();
  render(
    <ul>
      <MainSetRow exerciseName="Bench press" index={0} dataSet={s.id} set={s} extra={extra} onCheck={onCheck} onEdit={onEdit} />
    </ul>,
    { container: root() },
  );
  return { onCheck, onEdit };
}
/**
 * The row's two controls: the check by the set's name, the values control by "Edit" + what the
 * row shows (`shown`: the same words as the name unless the row writes them differently).
 */
const controls = (name: string, shown = name) => ({
  check: screen.getByRole("button", { name }),
  values: screen.getByRole("button", { name: `Edit ${shown}` }),
});
/** axe's label-in-name test (label-content-name-mismatch): the visible words, in order, within the name's. */
const words = (s: string) =>
  s
    .replace(/\([^()]*\)/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .toLowerCase();

describe("a set row's two controls", () => {
  it("the check logs: one press, nothing else happens", async () => {
    const user = userEvent.setup();
    const { onCheck, onEdit } = accessory(set(), "reps", false);
    const { check } = controls("Pull-up set 1: 8 reps");
    expect(check.getAttribute("aria-pressed")).toBe("false");
    await user.click(check);
    expect(onCheck).toHaveBeenCalledTimes(1);
    expect(onEdit).not.toHaveBeenCalled();
  });

  it("the check of a logged set is pressed, and pressing it again unlogs", async () => {
    const user = userEvent.setup();
    const { onCheck } = accessory(logged(), "reps", false);
    const { check } = controls("Pull-up set 1: 8 reps");
    expect(check.getAttribute("aria-pressed")).toBe("true");
    await user.click(check);
    expect(onCheck).toHaveBeenCalledTimes(1);
  });

  it("the values open the editor, and say so", async () => {
    const user = userEvent.setup();
    const { onCheck, onEdit } = accessory(set(), "reps", false);
    const { values } = controls("Pull-up set 1: 8 reps");
    expect(values.getAttribute("aria-haspopup")).toBe("dialog");
    expect(values.hasAttribute("aria-pressed")).toBe(false);
    await user.click(values);
    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(onCheck).not.toHaveBeenCalled();
  });

  it("needs no long press, right-click or Shift+F10: holding the values is just a press", async () => {
    const user = userEvent.setup();
    const { onCheck, onEdit } = accessory(set(), "reps", false);
    const { check, values } = controls("Pull-up set 1: 8 reps");
    await user.pointer([{ keys: "[MouseRight]", target: check }]);
    check.focus();
    await user.keyboard("{Shift>}{F10}{/Shift}");
    expect(onEdit).not.toHaveBeenCalled();
    expect(onCheck).not.toHaveBeenCalled();
    // Both are plain buttons: Enter / Space on each does its one thing.
    await user.keyboard("{Enter}");
    expect(onCheck).toHaveBeenCalledTimes(1);
    values.focus();
    await user.keyboard(" ");
    expect(onEdit).toHaveBeenCalledTimes(1);
  });

  it("carries the hooks the screen reveals the next open set by", () => {
    accessory(set({ id: "open" }), "reps", false);
    const row = root().querySelector('[data-set="open"]')!;
    expect(row.hasAttribute("data-open")).toBe(true);
    expect(row.contains(controls("Pull-up set 1: 8 reps").check)).toBe(true);
  });

  it("a logged row is no longer open", () => {
    accessory(logged({ id: "done" }), "reps", false);
    expect(root().querySelector('[data-set="done"]')!.hasAttribute("data-open")).toBe(false);
  });

  it("both controls are at least 44 px targets by class (an accessory row is 44 px, the check 64 px wide and as tall as its row)", () => {
    accessory(set(), "reps", false);
    const { check, values } = controls("Pull-up set 1: 8 reps");
    expect(values.className).toContain("min-h-11");
    expect(check.className).toContain("w-16");
    // The row stretches both controls to its height: the check is as tall as the values.
    expect(check.closest("li")!.className).toContain("items-stretch");
  });

  it("a main-lift row is 60 px", () => {
    main(set({ targetWeight: 170, targetReps: 6 }));
    expect(controls("Bench press set 1: 170 × 6").values.className).toContain("min-h-[3.75rem]");
  });

  it("the pencil reads as information (mute, 14 px), and the values keep 16 px clear of the check", () => {
    accessory(set(), "reps", false);
    const { values } = controls("Pull-up set 1: 8 reps");
    const pencil = values.querySelector("svg")!;
    expect(pencil.getAttribute("class")).toContain("text-mute");
    expect(pencil.getAttribute("class")).not.toContain("text-faint");
    expect(pencil.getAttribute("width")).toBe("14");
    expect(pencil.getAttribute("aria-hidden")).toBe("true");
    // The pencil ends the control's content; the padding after it is the gap to the check's target.
    expect(values.lastElementChild).toBe(pencil);
    expect(values.className.split(" ")).toContain("pr-4");
  });
});

describe("tone: logged rows recede mid-session and are the content of a record", () => {
  const numerals = (el: HTMLElement) => [...el.querySelectorAll(".num")].map((n) => n.className);
  const row = (node: ReactNode) => render(<ul>{node}</ul>, { container: root() });

  it("accessory: an open row is bright; a logged one mute mid-session, a step brighter on a record", () => {
    const { rerender } = row(<AccessorySetRow exerciseName="Curl" index={0} set={set({ targetWeight: 25 })} measure="reps" weighted />);
    const values = () => screen.getByRole("button", { name: /^Edit Curl set 1: / });
    for (const c of numerals(values())) expect(c).toMatch(/text-fg(?!-)/);
    rerender(
      <ul>
        <AccessorySetRow exerciseName="Curl" index={0} set={logged({ weight: 25 })} measure="reps" weighted />
      </ul>,
    );
    expect(numerals(values())).toHaveLength(2);
    for (const c of numerals(values())) expect(c).toContain("text-mute");
    rerender(
      <ul>
        <AccessorySetRow exerciseName="Curl" index={0} set={logged({ weight: 25 })} measure="reps" weighted record />
      </ul>,
    );
    for (const c of numerals(values())) {
      expect(c).toContain("text-fg-2");
      expect(c).not.toContain("text-mute");
    }
  });

  it("a record doesn't dim a row that was left open", () => {
    row(<AccessorySetRow exerciseName="Curl" index={0} set={set({ targetWeight: 25 })} measure="reps" weighted record />);
    for (const c of numerals(screen.getByRole("button", { name: /^Edit Curl set 1: / }))) expect(c).toMatch(/text-fg(?!-)/);
  });

  it("main lift: the load and its reps both come up a step on a record", () => {
    const done = set({ targetWeight: 170, targetReps: 6, done: true, weight: 170, reps: 6 });
    const { rerender } = row(<MainSetRow exerciseName="Bench press" index={0} set={done} />);
    const values = () => screen.getByRole("button", { name: /^Edit Bench press set 1: / });
    const reps = () => [...values().querySelectorAll("span")].find((s) => s.textContent === "× 6")!;
    expect(numerals(values())[0]).toContain("text-mute");
    expect(reps().className).toContain("text-mute");
    rerender(
      <ul>
        <MainSetRow exerciseName="Bench press" index={0} set={done} record />
      </ul>,
    );
    expect(numerals(values())[0]).toContain("text-fg-2");
    expect(reps().className).toContain("text-fg-2");
    expect(reps().className).not.toContain("text-mute");
  });

  it("a preview is the plan: its tone doesn't change", () => {
    row(<MainSetRow preview record exerciseName="Bench press" index={0} set={set({ targetWeight: 170, targetReps: 6 })} />);
    expect(screen.getByRole("listitem").querySelector(".num")!.className).toContain("text-fg-2");
  });
});

describe("accessory rows: every measure, with and without a load", () => {
  // [measure, weighted, set, the check's name after "Pull-up set 1: ", what the row shows after the set number]
  const cases: Array<[Measure, boolean, SetEntry, string, string]> = [
    ["reps", false, set(), "8 reps", "8 reps"],
    ["reps", false, set({ targetReps: 1 }), "1 rep", "1 rep"],
    ["reps", true, set({ targetWeight: 25 }), "8 reps at 25 lb", "8 × 25 lb"],
    ["reps", true, set(), "8 reps (no load)", "8 × – lb"],
    ["seconds", false, set({ targetReps: 30 }), "30s", "30 s"],
    ["seconds", true, set({ targetReps: 30, targetWeight: 25 }), "30s at 25 lb", "30 s · 25 lb"],
    ["seconds", true, set({ targetReps: 30 }), "30s (no load)", "30 s · – lb"],
    ["meters", false, set({ targetReps: 40 }), "40m", "40 m"],
    ["meters", true, set({ targetReps: 40, targetWeight: 70 }), "40m at 70 lb", "40 m · 70 lb"],
    ["meters", true, set({ targetReps: 40 }), "40m (no load)", "40 m · – lb"],
    // No target yet (a set added to an empty exercise).
    ["reps", false, set({ targetReps: null }), "no target", "– reps"],
    // An unweighted exercise's pending target load is neither named nor shown…
    ["reps", false, set({ targetWeight: 25 }), "8 reps", "8 reps"],
    // …but a load it was logged with is.
    ["reps", false, logged({ weight: 25 }), "8 reps at 25 lb", "8 × 25 lb"],
  ];
  it.each(cases)("%s, weighted %s: %o → “%s”, shown as “%s”", (measure, weighted, s, name, text) => {
    accessory(s, measure, weighted);
    const check = screen.getByRole("button", { name: `Pull-up set 1: ${name}` });
    expect(check.getAttribute("aria-pressed")).toBe(String(s.done));
    expect(check.textContent).toBe("");
    expect(accessorySetValues(s, measure, weighted)).toBe(name);
    // The values control is named by what it shows (a missing load or target also in words)…
    const said = /–/.test(text) ? (s.targetReps === null ? " (no target)" : " (no load)") : "";
    expect(accessorySetShown(s, measure, weighted)).toBe(`${text}${said}`);
    const values = screen.getByRole("button", { name: `Edit Pull-up set 1: ${text}${said}` });
    expect(values.textContent).toBe(`1 ${text}`);
    // …so its visible label is part of its accessible name, word for word (WCAG 2.5.3).
    expect(words(values.getAttribute("aria-label")!)).toContain(words(values.textContent!));
  });

  it("a logged row shows what was done, not the target", () => {
    accessory(logged({ targetReps: 8, reps: 6, targetWeight: 25, weight: 30 }), "reps", true);
    const { check, values } = controls("Pull-up set 1: 6 reps at 30 lb", "Pull-up set 1: 6 × 30 lb");
    expect(check.getAttribute("aria-pressed")).toBe("true");
    expect(values.textContent).toBe("1 6 × 30 lb");
  });

  it("a weighted set logged without a load says so", () => {
    accessory(logged(), "reps", true);
    expect(controls("Pull-up set 1: 8 reps (no load)", "Pull-up set 1: 8 × – lb (no load)").values.textContent).toBe("1 8 × – lb");
  });

  it("a set the check can't log yet announces the sheet it opens instead", () => {
    accessory(set(), "reps", true, { needsLoad: true });
    expect(screen.getByRole("button", { name: "Pull-up set 1: 8 reps (no load)" }).getAttribute("aria-haspopup")).toBe("dialog");
  });

  it("a set the check logs announces no sheet", () => {
    accessory(set({ targetWeight: 25 }), "reps", true);
    expect(screen.getByRole("button", { name: "Pull-up set 1: 8 reps at 25 lb" }).hasAttribute("aria-haspopup")).toBe(false);
  });
});

describe("main-lift rows", () => {
  it("names the load × reps, as planned", async () => {
    const user = userEvent.setup();
    const { onCheck, onEdit } = main(set({ targetWeight: 170, targetReps: 6 }));
    const { check, values } = controls("Bench press set 1: 170 × 6");
    expect(values.textContent).toBe("1 170 × 6");
    expect(words(values.getAttribute("aria-label")!)).toContain(words(values.textContent!));
    await user.click(check);
    await user.click(values);
    expect(onCheck).toHaveBeenCalledTimes(1);
    expect(onEdit).toHaveBeenCalledTimes(1);
  });

  it("shows what was logged once it is", () => {
    main(set({ targetWeight: 170, targetReps: 6, done: true, weight: 175, reps: 5 }));
    expect(controls("Bench press set 1: 175 × 5").check.getAttribute("aria-pressed")).toBe("true");
  });

  it("an open AMRAP says so, and its check opens the rep counter", () => {
    main(set({ targetWeight: 140, targetReps: 12, amrap: true }));
    const { check, values } = controls("Bench press set 1: 140 × 12+ AMRAP");
    expect(check.getAttribute("aria-haspopup")).toBe("dialog");
    expect(values.textContent).toBe("1 140 × 12+ AMRAP");
    expect(words(values.getAttribute("aria-label")!)).toContain(words(values.textContent!));
  });

  it("a beaten AMRAP shows the reps over target and the max bump, and its check just unlogs", () => {
    main(set({ targetWeight: 140, targetReps: 12, amrap: true, done: true, weight: 140, reps: 15, appliedProgressionLb: 3 }));
    const { check, values } = controls("Bench press set 1: 140 × 15 +3 reps · +3 lb");
    expect(words(values.getAttribute("aria-label")!)).toContain(words(values.textContent!));
    expect(check.getAttribute("aria-pressed")).toBe("true");
    expect(check.hasAttribute("aria-haspopup")).toBe(false);
  });

  it("an AMRAP logged at its target stays an AMRAP", () => {
    const s = set({ targetWeight: 140, targetReps: 12, amrap: true, done: true, weight: 140, reps: 12 });
    expect(mainSetTag(s, false)).toEqual({ text: "AMRAP", tone: "accent" });
    expect(mainSetValues(s, mainSetTag(s, false))).toBe("140 × 12 AMRAP");
  });

  it("tags a set added beyond the plan as a back-off", () => {
    main(set({ targetWeight: 150, targetReps: 10 }), true);
    expect(controls("Bench press set 1: 150 × 10 back-off").values.textContent).toBe("1 150 × 10 back-off");
  });

  it("previews read the plan and offer nothing to press", () => {
    render(
      <ul>
        <MainSetRow preview exerciseName="Bench press" index={3} set={set({ targetWeight: 140, targetReps: 12, amrap: true })} />
      </ul>,
      { container: root() },
    );
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByRole("listitem").textContent).toBe("Set 4: 12 reps at 140 lb, AMRAP4 140 × 12+ AMRAP");
  });
});

describe("checkAction", () => {
  it("logs or unlogs a set that has what it needs", () => {
    expect(checkAction(set(), "accessory", false)).toBe("toggle");
    expect(checkAction(set({ targetWeight: 25 }), "accessory", true)).toBe("toggle");
    expect(checkAction(logged(), "accessory", true)).toBe("toggle");
    expect(checkAction(set({ targetWeight: 170 }), "primary", true)).toBe("toggle");
  });
  it("sends an open AMRAP to its rep counter; a logged one just unlogs", () => {
    expect(checkAction(set({ amrap: true, targetWeight: 140 }), "primary", true)).toBe("count");
    expect(checkAction(logged({ amrap: true, weight: 140 }), "primary", true)).toBe("toggle");
  });
  it("sends a weighted accessory set with no load to the editor — never the main lift, never an unweighted set", () => {
    expect(checkAction(set(), "accessory", true)).toBe("load");
    expect(checkAction(set({ targetWeight: 0 }), "accessory", true)).toBe("load");
    expect(checkAction(set(), "accessory", false)).toBe("toggle");
    expect(checkAction(set(), "primary", true)).toBe("toggle");
  });
});
