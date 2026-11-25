/**
 * The "Swap the main lift" sheet on its own: what it offers in which order (the planned lift back,
 * the lifts still to do this week, the program's main lifts with their days, then other lifts), a
 * lift without a max that opens its max first, "Another exercise" at the foot, the "Add a main
 * lift" form of it, and the refusal that takes the list's place once a main-lift set is logged.
 */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SwapLiftSheet, type SwapLiftOption } from "./SwapLiftSheet";

const options: SwapLiftOption[] = [
  { id: 1, name: "Bench press", days: "Mon", noMax: false },
  { id: 3, name: "Back squat", days: "Wed", noMax: false },
  { id: 5, name: "Strict press", days: "Thu", noMax: true },
  { id: 4, name: "Front squat", days: "", noMax: true },
  { id: 6, name: "Pause squat", days: "", noMax: false },
];
const renderSheet = (props: Partial<Parameters<typeof SwapLiftSheet>[0]> = {}) => {
  const onPick = vi.fn();
  const onSetMax = vi.fn();
  const onAnother = vi.fn();
  render(
    <SwapLiftSheet
      open
      onClose={() => {}}
      current="Deadlift"
      dayLabel="Pull"
      back={null}
      options={options}
      blocked={null}
      onPick={onPick}
      onSetMax={onSetMax}
      onAnother={onAnother}
      {...props}
    />,
    { container: document.getElementById("root")! },
  );
  const title = props.mode === "add" ? "Add a main lift" : "Swap the main lift";
  return { onPick, onSetMax, onAnother, sheet: within(screen.getByRole("dialog", { name: title })) };
};
const labels = (list: HTMLElement) =>
  within(list)
    .getAllByRole("button")
    .map((b) => b.getAttribute("aria-label"));

describe("SwapLiftSheet", () => {
  it("lists the program's main lifts with their days first, then the other lifts; says what stays", () => {
    const { sheet } = renderSheet();
    expect(sheet.getByText(/For this session only/).textContent).toBe(
      "For this session only: Pull keeps its accessories, and the plan doesn't change.",
    );
    const [program, others] = sheet.getAllByRole("list");
    expect(labels(program!)).toEqual(["Bench press · Mon", "Back squat · Wed", "Strict press · Thu · no max yet: set it first"]);
    expect(labels(others!)).toEqual(["Front squat · no max yet: set it first", "Pause squat"]);
    expect(sheet.queryByRole("button", { name: /Back to the planned lift/ })).toBeNull();
  });

  it("picks a lift; one without a max is a real button that opens its max first — no dead ends", async () => {
    const { onPick, onSetMax, sheet } = renderSheet();
    for (const b of sheet.getAllByRole("button")) expect(b.getAttribute("aria-disabled")).toBeNull();
    const noMax = sheet.getByRole("button", { name: "Front squat · no max yet: set it first" });
    expect(noMax.getAttribute("aria-haspopup")).toBe("dialog");
    expect(noMax.textContent).toBe("Front squatset max");
    await userEvent.click(noMax);
    expect(onSetMax).toHaveBeenCalledWith(4);
    expect(onPick).not.toHaveBeenCalled();
    await userEvent.click(sheet.getByRole("button", { name: "Back squat · Wed" }));
    expect(onPick).toHaveBeenCalledWith(3);
  });

  it("lists a lift still to do this week first, under its own heading", () => {
    const { sheet } = renderSheet({ options: options.map((o) => (o.id === 3 ? { ...o, missed: true } : o)) });
    const lists = sheet.getAllByRole("list");
    expect(sheet.getAllByRole("heading", { level: 4 }).map((h) => h.textContent)).toEqual([
      "Still to do this week",
      "The program's other main lifts",
      "Other lifts",
    ]);
    expect(labels(lists[0]!)).toEqual(["Back squat · Wed"]);
    expect(labels(lists[1]!)).toEqual(["Bench press · Mon", "Strict press · Thu · no max yet: set it first"]);
  });

  it("offers another exercise at the foot: skip the main lift and add one", async () => {
    const { onAnother, sheet } = renderSheet();
    const another = sheet.getByRole("button", { name: /^Another exercise/ });
    expect(another.textContent).toBe("Another exerciseSkip Deadlift and add one, with your own loads");
    await userEvent.click(another);
    expect(onAnother).toHaveBeenCalledOnce();
  });

  it("once swapped, offers the planned lift back first", async () => {
    const { onPick, sheet } = renderSheet({
      current: "Back squat",
      back: { id: 2, name: "Deadlift" },
      options: options.filter((o) => o.id !== 3),
    });
    const back = sheet.getByRole("button", { name: /Back to the planned lift/ });
    expect(back.textContent).toBe("Back to the planned liftDeadlift in place of Back squat");
    expect(sheet.getAllByRole("button").filter((b) => b.hasAttribute("data-swap-back") || b.hasAttribute("data-swap-to"))[0]).toBe(back);
    await userEvent.click(back);
    expect(onPick).toHaveBeenCalledWith(2);
  });

  it("adds a main lift on a day without one: the same list under its own title", async () => {
    const { onPick, sheet } = renderSheet({ mode: "add", current: "", dayLabel: "Carries & pull" });
    expect(sheet.getByText(/For this session only/).textContent).toBe(
      "For this session only: Carries & pull keeps its accessories, and the plan doesn't change.",
    );
    expect(sheet.getByRole("button", { name: /^Another exercise/ }).textContent).toBe("Another exerciseAdd one with your own loads");
    await userEvent.click(sheet.getByRole("button", { name: "Bench press · Mon" }));
    expect(onPick).toHaveBeenCalledWith(1);
  });

  it("says why it can't swap in place of the list", () => {
    const { sheet } = renderSheet({ blocked: "A set of Deadlift is logged." });
    expect(sheet.getByRole("status").textContent).toBe("A set of Deadlift is logged.");
    expect(sheet.queryAllByRole("list")).toHaveLength(0);
    expect(sheet.queryByRole("button", { name: /Back squat|Another exercise/ })).toBeNull();
  });
});
