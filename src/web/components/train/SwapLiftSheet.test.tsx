/**
 * The "Swap the main lift" sheet on its own: what it offers in which order (the planned lift back,
 * the program's main lifts with their days, then other lifts), a lift without a max that can't be
 * picked, and the refusal that takes the list's place once a main-lift set is logged.
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
      {...props}
    />,
    { container: document.getElementById("root")! },
  );
  return { onPick, sheet: within(screen.getByRole("dialog", { name: "Swap the main lift" })) };
};

describe("SwapLiftSheet", () => {
  it("lists the program's main lifts with their days first, then the other lifts; says what stays", () => {
    const { sheet } = renderSheet();
    expect(sheet.getByText(/For this session only/).textContent).toBe(
      "For this session only: Pull keeps its accessories, and the plan doesn't change.",
    );
    const [program, others] = sheet.getAllByRole("list");
    expect(
      within(program!)
        .getAllByRole("button")
        .map((b) => b.getAttribute("aria-label")),
    ).toEqual(["Bench press · Mon", "Back squat · Wed", "Strict press · Thu · no max yet"]);
    expect(
      within(others!)
        .getAllByRole("button")
        .map((b) => b.getAttribute("aria-label")),
    ).toEqual(["Front squat · no max yet", "Pause squat"]);
    expect(sheet.queryByRole("button", { name: /Back to the planned lift/ })).toBeNull();
  });

  it("picks a lift; one without a max is disabled and does nothing", async () => {
    const { onPick, sheet } = renderSheet();
    await userEvent.click(sheet.getByRole("button", { name: "Front squat · no max yet" }));
    expect(onPick).not.toHaveBeenCalled();
    expect(sheet.getByRole("button", { name: "Front squat · no max yet" }).getAttribute("aria-disabled")).toBe("true");
    await userEvent.click(sheet.getByRole("button", { name: "Back squat · Wed" }));
    expect(onPick).toHaveBeenCalledWith(3);
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

  it("says why it can't swap in place of the list", () => {
    const { sheet } = renderSheet({ blocked: "A set of Deadlift is logged." });
    expect(sheet.getByRole("status").textContent).toBe("A set of Deadlift is logged.");
    expect(sheet.queryAllByRole("list")).toHaveLength(0);
    expect(sheet.queryByRole("button", { name: /Back squat/ })).toBeNull();
  });
});
