/**
 * The Metcon section of a Train day (DESIGN A.2, A.4, B.4; mockups 01, 06, 07): the done check in
 * the head's check column; Not today (`metconSkipped`, through the day's save) only while nothing
 * is logged, with an Undo toast that patches only its own field on the day as it is when tapped,
 * and Bring back; a done section's one-line summary, all a folded section shows — folded only at
 * the fold moments (`folds.ts`), never while the page is in use; and the typing rules (a skip saved
 * elsewhere waits while a field is typed in).
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultSettings } from "../../../shared/defaults";
import { emptyDayLog } from "../../../shared/empty";
import type { DayLog, DayLogPatch } from "../../../shared/schemas";
import type { DayData } from "../../../shared/sections";
import { DockProvider } from "../Dock";
import { SectionHarness, type HarnessControl } from "../sections/harness";
import { ToastProvider } from "../Toast";
import { forgetFolds } from "./folds";
import { MetconSection } from "./MetconSection";

const store = vi.hoisted(() => ({ data: null as unknown }));
vi.mock("../../lib/store", () => ({ useData: () => ({ data: store.data }) }));
vi.mock("../../lib/sync", () => ({ currentData: () => store.data }));

const TODAY = "2026-11-10"; // a Tuesday: metcon is planned (Mon–Sat)
const ids = { bench: 1, deadlift: 2, backSquat: 3, frontSquat: 4, strictPress: 5 };
const settings = { ...defaultSettings(ids, "2026-11-01"), onboarded: true };
const day = (date: string, o: Partial<DayLog>): DayLog => ({ ...emptyDayLog(date), ...o });
/** Fran, done in 4:30 a week ago. */
const FRAN_BEFORE = day("2026-11-03", { metconDone: true, metconBenchmark: "Fran", metconScore: "4:30" });

// jsdom has no layout: a text area brought into view after a Tab.
Element.prototype.scrollIntoView ??= () => {};

function setup(o: { days?: DayLog[]; date?: string; today?: string; added?: boolean } = {}) {
  const control: HarnessControl = { patches: [] as DayLogPatch[], external: () => {} };
  const data: DayData = { settings, days: o.days ?? [FRAN_BEFORE], sessions: [], exercises: [], maxEntries: [] };
  const ui = (
    <DockProvider>
      <ToastProvider>
        <SectionHarness
          Section={MetconSection}
          kind="metcon"
          data={data}
          date={o.date ?? TODAY}
          today={o.today ?? TODAY}
          added={o.added}
          publish={(d) => (store.data = d)}
          control={control}
        />
      </ToastProvider>
    </DockProvider>
  );
  const view = render(ui);
  return { control, ui, ...view };
}

afterEach(() => {
  cleanup();
  forgetFolds();
});

const section = () => screen.getByRole("region", { name: "Metcon" });
const meta = () => document.getElementById(section().getAttribute("aria-describedby")!)!.textContent;
const check = () => screen.getByRole("button", { name: "Metcon complete" });
const notToday = () => screen.queryByRole("button", { name: "Not today: Metcon" });
const bringBack = () => screen.queryByRole("button", { name: "Bring back Metcon" });
const notes = () => screen.queryByRole("textbox", { name: "Metcon notes" });
const field = (name: string) => screen.getByLabelText(name, { selector: "input" });
const live = () =>
  screen
    .getAllByRole("status")
    .map((s) => s.textContent)
    .join(" ");
const hide = () => {
  Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
};

describe("MetconSection", () => {
  it("is a numbered section: its plan under the title, the check in the head's check column, Not today, then the editor", () => {
    setup();
    const s = section();
    expect(s.id).toBe("metcon");
    expect(within(s).getByRole("heading", { level: 2, name: "Metcon" })).toBeTruthy();
    expect(s.querySelector("[data-index]")!.textContent).toBe("01");
    expect(meta()).toBe("CrossFit");
    // The check is the head's last control, at the right of the title's line, before the body.
    const head = s.querySelector("h2")!.parentElement!;
    expect(head.contains(check())).toBe(true);
    expect(head.contains(notToday())).toBe(true);
    expect(check().getAttribute("aria-pressed")).toBe("false");
    expect(notToday()!.compareDocumentPosition(check()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(head.contains(field("Benchmark name"))).toBe(false);
    expect(notes()).toBeTruthy();
  });

  it("ticks off with its check, through the day's save; done, Not today goes and the summary is its meta — and it doesn't fold under the thumb", async () => {
    const user = userEvent.setup();
    const { control } = setup();
    await user.click(check());
    expect(control.patches).toEqual([{ metconDone: true }]);
    expect(check().getAttribute("aria-pressed")).toBe("true");
    expect(section().dataset.state).toBe("done");
    expect(notToday()).toBeNull();
    expect(meta()).toBe("CrossFit");
    // Still open: nothing folds while the page is in use. It folds by hand.
    expect(notes()).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Fold Metcon" }));
    expect(notes()).toBeNull();
    await user.click(screen.getByRole("button", { name: "Show Metcon" }));
    expect(notes()).toBeTruthy();
    // Unticked: to do again (nothing else logged), Not today offered again.
    await user.click(check());
    expect(control.patches.at(-1)).toEqual({ metconDone: false });
    expect(notToday()).toBeTruthy();
  });

  it("summarises a benchmark logged as name · score · New best (gold), and folds to that one line at the fold moments", async () => {
    const user = userEvent.setup();
    const { control } = setup();
    await user.type(field("Benchmark name"), "Fran");
    await user.click(field("Benchmark score"));
    await user.type(field("Benchmark score"), "4:12");
    await user.tab();
    expect(control.patches).toEqual([
      { metconBenchmark: "Fran", metconDone: true },
      { metconScore: "4:12", metconDone: true },
    ]);
    expect(meta()).toBe("Fran · 4:12 · New best");
    expect(within(document.getElementById(section().getAttribute("aria-describedby")!)!).getByText("New best").className).toContain(
      "text-gold",
    );
    // Done while in use: still open.
    expect(notes()).toBeTruthy();
    // Back in the foreground (a fold moment): it shows as its head and summary only.
    act(() => hide());
    expect(notes()).toBeNull();
    expect(section().querySelector("[data-section-heading]")).toBeTruthy();
    expect(meta()).toBe("Fran · 4:12 · New best");
    expect(check().getAttribute("aria-pressed")).toBe("true");
    const show = screen.getByRole("button", { name: "Show Metcon" });
    expect(show.getAttribute("aria-expanded")).toBe("false");
    expect(show.dataset.foldToggle).toBe("metcon");
  });

  it("opens folded when its day is opened done; a past day not done says so, and keeps its check", () => {
    setup({ days: [FRAN_BEFORE, day(TODAY, { metconDone: true, metconNotes: "EMOM 12: 10 burpees + 12 KB swings\nfelt good" })] });
    expect(notes()).toBeNull();
    expect(meta()).toBe("EMOM 12: 10 burpees + 12 KB swings");
    cleanup();
    setup({ date: "2026-11-09", days: [] });
    expect(meta()).toBe("Not done · CrossFit");
    expect(section().dataset.state).toBe("missed");
    expect(check()).toBeTruthy();
    expect(notToday()).toBeTruthy();
  });

  it("Not today: saves metconSkipped, shows one muted line and Bring back (focused); Undo puts back only its own field; Bring back clears it", async () => {
    const user = userEvent.setup();
    const { control } = setup();
    await user.click(notToday()!);
    expect(control.patches).toEqual([{ metconSkipped: true }]);
    expect(section().dataset.state).toBe("skipped");
    expect(notes()).toBeNull();
    expect(screen.queryByRole("button", { name: "Metcon complete" })).toBeNull();
    expect(within(section()).getByText("Stays open on the checklist")).toBeTruthy();
    await vi.waitFor(() => expect(document.activeElement).toBe(bringBack()));
    expect(live()).toContain("Metcon: not today");

    await user.click(screen.getByRole("button", { name: "Undo" }));
    expect(control.patches.at(-1)).toEqual({ metconSkipped: false });
    expect(notes()).toBeTruthy();
    await vi.waitFor(() => expect(document.activeElement).toBe(notToday()));

    await user.click(notToday()!);
    await user.click(bringBack()!);
    expect(control.patches.slice(-2)).toEqual([{ metconSkipped: true }, { metconSkipped: false }]);
    expect(notes()).toBeTruthy();
    expect(notToday()).toBeTruthy();
    // Bring back took the Undo off offer.
    expect(live()).not.toContain("Metcon: not today");
  });

  it("Undo patches the day as it is when tapped: brought back elsewhere meanwhile, it saves nothing", async () => {
    const user = userEvent.setup();
    const { control } = setup();
    await user.click(notToday()!);
    act(() => control.external({ metconSkipped: false }));
    await user.click(screen.getByRole("button", { name: "Undo" }));
    expect(control.patches).toEqual([{ metconSkipped: true }]);
  });

  it("offers Not today only while nothing is logged: not once the notes are written (unticked or not)", async () => {
    const user = userEvent.setup();
    const { control } = setup();
    await user.type(notes()!, "Cindy, 20 rounds");
    await user.tab();
    expect(control.patches[0]).toEqual({ metconNotes: "Cindy, 20 rounds", metconDone: true });
    expect(notToday()).toBeNull();
    await user.click(check());
    expect(section().dataset.state).toBe("active");
    expect(notToday()).toBeNull();
  });

  it("an added section says so and has Remove instead of Not today", async () => {
    const user = userEvent.setup();
    // Sunday: no metcon planned.
    setup({ date: "2026-11-08", today: "2026-11-08", days: [], added: true });
    expect(meta()).toBe("Added for today");
    expect(notToday()).toBeNull();
    await user.click(screen.getByRole("button", { name: "Remove Metcon" }));
    expect(screen.queryByRole("region", { name: "Metcon" })).toBeNull();
  });

  it("a preview is its head alone: the plan, no check, no Not today, no editor", () => {
    setup({ date: "2026-11-11", days: [] });
    expect(section().dataset.state).toBe("planned");
    expect(meta()).toBe("CrossFit");
    expect(screen.queryByRole("button", { name: "Metcon complete" })).toBeNull();
    expect(notToday()).toBeNull();
    expect(notes()).toBeNull();
  });

  it("typing stays put: a skip saved elsewhere waits while a field is typed in (the field stays, focused), then catches up", async () => {
    const user = userEvent.setup();
    const { control } = setup();
    const field1 = notes()!;
    await user.click(field1);
    act(() => control.external({ metconSkipped: true }));
    expect(notes()).toBe(field1);
    expect(document.activeElement).toBe(field1);
    expect(bringBack()).toBeNull();
    // From field to field: still typing.
    const score = field("Benchmark score");
    await user.click(score);
    expect(notes()).toBe(field1);
    expect(bringBack()).toBeNull();
    // Nothing typed in any more: it catches up.
    act(() => score.blur());
    await vi.waitFor(() => expect(section().dataset.state).toBe("skipped"));
    expect(notes()).toBeNull();
    expect(bringBack()).toBeTruthy();
    expect(control.patches).toEqual([]);
  });

  it("a tap of its own shows at once, a field focused or not", async () => {
    const user = userEvent.setup();
    const { control } = setup();
    await user.click(field("Benchmark name"));
    await user.click(notToday()!);
    expect(control.patches).toEqual([{ metconSkipped: true }]);
    expect(section().dataset.state).toBe("skipped");
    expect(screen.queryByLabelText("Benchmark name")).toBeNull();
  });

  it("a value typed and not yet left is saved when the app is hidden — once, through the day's save", async () => {
    const user = userEvent.setup();
    const { control } = setup();
    await user.click(field("Benchmark score"));
    await user.keyboard("12+4");
    act(() => hide());
    expect(control.patches).toEqual([{ metconScore: "12+4", metconDone: true }]);
    expect(check().getAttribute("aria-pressed")).toBe("true");
  });
});
