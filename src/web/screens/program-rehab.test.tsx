/**
 * Program › Rehab (behind the `rehab` flag): the empty state sets up the first rehab block; a
 * block in force reads its week, dates and sessions and edits its days, length, start and carry;
 * "+ A week" says what it will do; End today / Cancel; earlier blocks; a new block starts where
 * `newRehabStart` says and an overlap is refused with its reason. Every change has an Undo on the
 * settings as they are when it is tapped, putting back only its own field. Without the flag,
 * Program and Settings are exactly as before.
 */
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultSettings } from "../../shared/defaults";
import type { Exercise, RehabProgram, Session, Settings } from "../../shared/schemas";
import { FLAGS_KEY } from "../lib/features";
import { programJumps, ProgramScreen } from "./Program";
import { SettingsScreen } from "./Settings";

// A Wednesday: Knee rehab (from Mon Oct 19) is in its week 3.
const TODAY = "2026-11-04";

type Toast = { message: string; tone?: string; action?: { label: string; onAction: () => void } };

const store = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  type S = import("../../shared/schemas").Settings;
  type E = import("../../shared/schemas").Exercise;
  type Se = import("../../shared/schemas").Session;
  const state = {
    data: null as unknown as { settings: S; exercises: E[]; sessions: Se[]; seenAchievements: string[] },
    today: "",
    listeners,
    saved: [] as S[],
    toasts: [] as Array<{ message: string; tone?: string; action?: { label: string; onAction: () => void } }>,
    dismissed: [] as number[],
    reset(settings: S, exercises: E[], sessions: Se[], today: string) {
      state.saved = [];
      state.sessionWrites = [];
      state.toasts = [];
      state.dismissed = [];
      state.today = today;
      state.data = { settings, exercises, sessions, seenAchievements: [] };
    },
    remote(next: S) {
      state.data = { ...state.data, settings: next };
      for (const l of listeners) l();
    },
    save(next: S) {
      state.saved.push(next);
      state.remote(next);
      return Promise.resolve(next);
    },
    /** Session writes, in order, as the outbox gets them (`doc: null`: deleted). */
    sessionWrites: [] as Array<{ date: string; doc: Se | null }>,
    writeSession(date: string, doc: Se | null) {
      state.sessionWrites.push({ date, doc });
      const others = state.data.sessions.filter((s) => s.date !== date);
      state.data = { ...state.data, sessions: doc ? [...others, doc] : others };
      for (const l of listeners) l();
    },
  };
  return state;
});
vi.mock("../lib/store", async () => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (l: () => void) => {
    store.listeners.add(l);
    return () => store.listeners.delete(l);
  };
  return {
    useData: () => ({ data: useSyncExternalStore(subscribe, () => store.data), today: store.today }),
    useSaveSettings: () => store.save,
    useSaveSession: () => (s: import("../../shared/schemas").Session) => store.writeSession(s.date, s),
    useDeleteSession: () => (date: string) => store.writeSession(date, null),
    useCreateExercise: () => vi.fn(),
    useEditExercise: () => vi.fn(),
    useMarkSeen: () => vi.fn(),
    useSyncInfo: () => ({
      online: true,
      pending: 0,
      failed: 0,
      unsynced: 0,
      lastSyncedAt: null,
      items: [],
      refused: [],
      syncNow: vi.fn(),
      retryFailed: vi.fn(),
      discardFailed: vi.fn(),
      clearRefused: vi.fn(),
    }),
    signOut: vi.fn(),
    forgetDevice: vi.fn(),
  };
});
vi.mock("../lib/sync", () => ({ currentData: () => store.data }));
vi.mock("../components/Toast", () => ({
  useToast: () => ({
    show: (t: Toast) => store.toasts.push(t),
    dismiss: (id: number) => void store.dismissed.push(id),
  }),
}));

const EXERCISES: Exercise[] = [
  { id: 1, name: "Bench press", category: "primary", tracksMax: true, measure: "reps", weighted: true, archived: false },
  { id: 20, name: "Spanish squat", category: "accessory", tracksMax: false, measure: "seconds", weighted: false, archived: false },
];
const base = (): Settings => ({
  ...defaultSettings({ bench: 1, deadlift: 1, backSquat: 1, frontSquat: 1, strictPress: 1 }, "2026-11-02"),
  onboarded: true,
});
const MWF = [false, true, false, true, false, true, false];
const knee = (o: Partial<RehabProgram> = {}): RehabProgram => ({
  id: "knee",
  name: "Knee rehab",
  start: "2026-10-19",
  weeks: 6,
  days: [...MWF],
  carry: "last",
  ...o,
});
const shoulder = knee({ id: "shoulder", name: "Shoulder rehab", start: "2026-07-06", weeks: 6, end: undefined });
const withRehab = (...programs: RehabProgram[]): Settings => ({ ...base(), rehab: { programs } });
/** A session on `date` with a logged rehab set of the block `rehab`. */
const rehabSession = (date: string, rehab = "knee"): Session => ({
  date,
  label: "Push",
  cycle: 1,
  week: 1,
  deload: false,
  primaryMaxLb: null,
  blocks: [
    {
      id: `r-${date}`,
      kind: "rehab",
      rehab,
      exercises: [
        {
          exerciseId: 20,
          measure: "seconds",
          sets: [
            { id: "s1", targetReps: 45, targetWeight: null, reps: 45, weight: null, done: true, amrap: false, appliedProgressionLb: null },
          ],
        },
      ],
    },
  ],
  notes: "",
  completedAt: null,
});
/** `date`'s session as the first rehab edit saves it: the knee draft, nothing logged. */
const draftOf = (date: string): Session => {
  const s = rehabSession(date);
  const b = s.blocks[0]!;
  return {
    ...s,
    blocks: [
      { ...b, id: "draft", exercises: b.exercises.map((e) => ({ ...e, sets: e.sets.map((x) => ({ ...x, reps: null, done: false })) })) },
    ],
  };
};
/** A strength block, before the rehab draft. */
const STRENGTH: Session["blocks"][number] = {
  id: "main",
  kind: "primary",
  exercises: [
    {
      exerciseId: 1,
      measure: "reps",
      sets: [
        { id: "p1", targetReps: 5, targetWeight: 185, reps: null, weight: null, done: false, amrap: false, appliedProgressionLb: null },
      ],
    },
  ],
};
const withStrength = (s: Session): Session => ({ ...s, blocks: [STRENGTH, ...s.blocks] });
const reset = (settings: Settings = base(), sessions: Session[] = []) => store.reset(settings, EXERCISES, sessions, TODAY);

let clock = 0;
beforeEach(() => {
  window.localStorage.setItem(FLAGS_KEY, "rehab");
  reset();
  clock = Date.parse("2026-11-04T10:00:00Z");
  vi.spyOn(Date, "now").mockImplementation(() => clock);
});
afterEach(() => {
  window.localStorage.removeItem(FLAGS_KEY);
  vi.restoreAllMocks();
});

const show = (at = "/program") =>
  render(
    <MemoryRouter initialEntries={[at]}>
      <Routes>
        <Route path="/program" element={<ProgramScreen />} />
        <Route path="/settings" element={<SettingsScreen />} />
      </Routes>
    </MemoryRouter>,
  );
const rehab = () => document.getElementById("rehab")!;
const programs = () => store.data.settings.rehab?.programs ?? [];
const block = (id = "knee") => programs().find((p) => p.id === id);
const lastToast = () => store.toasts.at(-1)!;
const undo = (toast: Toast = lastToast()) => act(() => toast.action!.onAction());
const sectionHeadings = () => screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
const jumpNames = () =>
  within(screen.getByRole("navigation", { name: "Program sections" }))
    .getAllByRole("link")
    .map((a) => a.textContent);
const described = (el: HTMLElement) => document.getElementById(el.getAttribute("aria-describedby")!)!.textContent;
const day = (group: string, name: string) => within(screen.getByRole("group", { name: group })).getByRole("button", { name });

describe("the rehab flag", () => {
  it("off: Program has no Rehab section or jump, and Settings no Rehab row — exactly as before", () => {
    window.localStorage.removeItem(FLAGS_KEY);
    reset(withRehab(knee()));
    const { unmount } = show();
    expect(sectionHeadings()).toEqual([
      "Now",
      "Weekly layout",
      "Targets & days",
      "Cycle weeks",
      "Rules",
      "Rep-max table",
      "Exercise library",
    ]);
    expect(jumpNames()).toEqual(["Now", "Layout", "Targets", "Weeks", "Rules", "Rep-max", "Library"]);
    expect(document.getElementById("rehab")).toBeNull();
    unmount();
    show("/settings");
    expect(document.querySelector('[data-program-link="rehab"]')).toBeNull();
    expect(document.querySelectorAll("[data-program-link]")).toHaveLength(2);
  });

  it("on: Rehab sits between Targets & days and Cycle weeks, in the jump list too; Settings links to it", () => {
    const { unmount } = show();
    expect(sectionHeadings()).toEqual([
      "Now",
      "Weekly layout",
      "Targets & days",
      "Rehab",
      "Cycle weeks",
      "Rules",
      "Rep-max table",
      "Exercise library",
    ]);
    expect(jumpNames()).toEqual(["Now", "Layout", "Targets", "Rehab", "Weeks", "Rules", "Rep-max", "Library"]);
    expect(programJumps(false).map(([id]) => id)).not.toContain("rehab");
    unmount();
    show("/settings");
    const row = screen.getByRole("link", { name: /^Rehab/ });
    expect(row.getAttribute("href")).toBe("/program#rehab");
  });
});

describe("Program › Rehab", () => {
  it("with no block yet: an empty state that sets up the first — Knee rehab, 6 weeks, M/W/F from today — with an Undo", async () => {
    const user = userEvent.setup();
    show();
    expect(within(rehab()).getByText("No rehab block yet")).toBeTruthy();
    const setUp = within(rehab()).getByRole("button", { name: "Set up a rehab block" });
    expect(described(setUp)).toBe("Starts today.");
    await user.click(setUp);

    // The form starts as a knee protocol would: Mon / Wed / Fri, six weeks, from today.
    for (const d of ["Mon", "Wed", "Fri"]) expect(day("New rehab block days", d).getAttribute("aria-pressed")).toBe("true");
    expect(day("New rehab block days", "Tue").getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("group", { name: "New rehab block length" }).textContent).toContain("6 weeks");
    expect(within(rehab()).getByText("Ends Dec 15")).toBeTruthy();

    // A name is needed; nothing is saved without one.
    await user.click(screen.getByRole("button", { name: "Start it" }));
    expect(screen.getByRole("alert").textContent).toBe("Name the rehab block.");
    expect(store.saved).toHaveLength(0);

    await user.type(screen.getByRole("textbox", { name: "Name" }), "Knee rehab");
    await user.click(screen.getByRole("button", { name: "Start it" }));
    expect(programs()).toHaveLength(1);
    const p = programs()[0]!;
    expect({ ...p, id: "x" }).toEqual({ id: "x", name: "Knee rehab", start: TODAY, weeks: 6, days: MWF, carry: "last" });
    expect(lastToast().message).toBe("Knee rehab set up from Wed Nov 4");
    // The card: week 1, its dates, and nothing logged yet.
    expect(within(rehab()).getByRole("textbox", { name: "Rehab block name" })).toHaveProperty("value", "Knee rehab");
    expect(rehab().querySelector("[data-rehab-status]")!.textContent).toBe("Week 1 of 6 · Nov 4 – Dec 150 of 18 sessions logged");

    // Undo takes it away again; the rest of the settings is as it was.
    undo();
    expect(programs()).toHaveLength(0);
    expect(within(rehab()).getByText("No rehab block yet")).toBeTruthy();
  });

  it("a block in force: its week, dates and sessions, the week rail, and what + A week would do", () => {
    reset(withRehab(knee(), shoulder), [rehabSession("2026-10-19"), rehabSession("2026-10-21"), rehabSession("2026-07-08", "shoulder")]);
    show();
    const card = rehab().querySelector<HTMLElement>('[data-rehab-block="knee"]')!;
    expect(card.querySelector("[data-rehab-status]")!.textContent).toBe("Week 3 of 6 · Oct 19 – Nov 292 of 18 sessions logged");
    expect(card.querySelector("[data-rehab-rail]")!.textContent).toBe("W1W2W3W4W5W6");
    for (const d of ["Mon", "Wed", "Fri"]) expect(day("Knee rehab days", d).getAttribute("aria-pressed")).toBe("true");
    expect(within(card).getByText("Ends Nov 29")).toBeTruthy();
    expect(within(card).getByLabelText<HTMLInputElement>("Started").value).toBe("2026-10-19");
    expect(within(card).getByRole("button", { name: "The last session" }).getAttribute("aria-pressed")).toBe("true");
    const extend = within(card).getByRole("button", { name: "A week" });
    expect(described(extend)).toBe("“+ A week” ends it Sun Dec 6 instead of Nov 29.");
    expect(within(card).getByRole("button", { name: "End today" })).toBeTruthy();
    // Logged sessions: it is ended, not cancelled.
    expect(within(card).queryByRole("button", { name: "Cancel it" })).toBeNull();

    // Earlier blocks, read-only.
    const history = rehab().querySelector<HTMLElement>("[data-rehab-history]")!;
    expect(within(history).getByRole("heading", { level: 3 }).textContent).toBe("Earlier rehab blocks");
    expect(within(history).getByRole("listitem").textContent).toBe("Shoulder rehabJul 6 – Aug 16 · 1 session");
    expect(within(history).queryByRole("button")).toBeNull();
  });

  it("+ A week and the length stepper fold into one Undo that puts back the length only", async () => {
    const user = userEvent.setup({ advanceTimers: () => {} });
    reset(withRehab(knee()));
    show();
    await user.click(screen.getByRole("button", { name: "A week" }));
    expect(block()!.weeks).toBe(7);
    expect(lastToast().message).toBe("Knee rehab ends Sun Dec 6");
    expect(described(screen.getByRole("button", { name: "A week" }))).toBe("“+ A week” ends it Sun Dec 13 instead of Dec 6.");
    clock += 1000;
    await user.click(screen.getByRole("button", { name: "Increase Knee rehab length" }));
    expect(block()!.weeks).toBe(8);
    expect(store.dismissed).toHaveLength(1); // the first toast made way for the folded one
    expect(lastToast().message).toBe("Knee rehab ends Sun Dec 13");
    // Another device renames it meanwhile, and changes a preference.
    const other = structuredClone(store.data.settings);
    other.rehab!.programs[0]!.name = "Left knee rehab";
    other.nutrition.kcalPerLb = 3600;
    act(() => store.remote(other));
    undo();
    expect(block()).toEqual(knee({ name: "Left knee rehab" }));
    expect(store.data.settings.nutrition.kcalPerLb).toBe(3600);
  });

  it("the − never shortens it past this week; shortened, its Undo goes back", async () => {
    const user = userEvent.setup();
    reset(withRehab(knee()));
    show();
    await user.click(screen.getByRole("button", { name: "Decrease Knee rehab length" }));
    expect(block()!.weeks).toBe(5);
    expect(lastToast().message).toBe("Knee rehab ends Sun Nov 22");
    // Week 3 of 5 → 4 → 3, and no further.
    await user.click(screen.getByRole("button", { name: "Decrease Knee rehab length" }));
    await user.click(screen.getByRole("button", { name: "Decrease Knee rehab length" }));
    expect(block()!.weeks).toBe(3);
    await user.click(screen.getByRole("button", { name: "Decrease Knee rehab length" }));
    expect(block()!.weeks).toBe(3);
    undo();
    expect(block()).toEqual(knee());
  });

  it("days: a toggle saves with an Undo that declines once the days were changed again elsewhere; the last day can't go", async () => {
    const user = userEvent.setup();
    reset(withRehab(knee()));
    show();
    await user.click(day("Knee rehab days", "Tue"));
    expect(block()!.days).toEqual([false, true, true, true, false, true, false]);
    expect(lastToast().message).toBe("Knee rehab days: Mon, Tue, Wed, Fri");
    const toast = lastToast();
    // Another device changes the days again: this Undo would undo theirs too, so it declines.
    const other = structuredClone(store.data.settings);
    other.rehab!.programs[0]!.days = [false, false, true, false, true, false, false];
    act(() => store.remote(other));
    const saves = store.saved.length;
    undo(toast);
    expect(store.saved).toHaveLength(saves);
    expect(lastToast()).toMatchObject({ message: "Can't undo: Knee rehab was changed again since.", tone: "warn" });

    // Down to one day: switching it off is refused, saying why.
    await user.click(day("Knee rehab days", "Tue"));
    expect(block()!.days).toEqual([false, false, false, false, true, false, false]);
    await user.click(day("Knee rehab days", "Thu"));
    expect(block()!.days).toEqual([false, false, false, false, true, false, false]);
    expect(lastToast()).toMatchObject({ message: "Pick at least one day.", tone: "warn" });
  });

  it("carry and start: each saves its own field with an Undo; the carry note keeps its box", async () => {
    const user = userEvent.setup();
    reset(withRehab(knee()));
    show();
    const note = screen.getByRole("group", { name: "Knee rehab: each session starts from" });
    expect(described(note)).toContain("Wednesday from Monday");
    await user.click(screen.getByRole("button", { name: "The same weekday" }));
    expect(block()!.carry).toBe("weekday");
    expect(lastToast().message).toBe("Knee rehab: each session starts from the same weekday");
    // Both explanations stay laid out (one shown): the choice never moves what is under it.
    expect(document.getElementById(note.getAttribute("aria-describedby")!)!.children).toHaveLength(2);
    undo();
    expect(block()!.carry).toBe("last");

    const started = screen.getByLabelText<HTMLInputElement>("Started");
    fireEvent.change(started, { target: { value: "2026-10-26" } });
    expect(block()!.start).toBe("2026-10-26");
    expect(lastToast().message).toBe("Knee rehab starts Mon Oct 26");
    undo();
    expect(block()).toEqual(knee());
    // A start that would leave it all in the past isn't saved: the card would leave from under the finger.
    const saves = store.saved.length;
    fireEvent.change(started, { target: { value: "2026-09-01" } });
    expect(store.saved).toHaveLength(saves);
    expect(lastToast()).toMatchObject({ message: "That would end Knee rehab before today: End today ends it.", tone: "warn" });
    expect(started.value).toBe("2026-10-19");
  });

  it("End today with nothing logged today: it ended yesterday, goes to the earlier blocks, and Undo brings it back as it was", async () => {
    const user = userEvent.setup();
    reset(withRehab(knee()), [rehabSession("2026-10-19")]);
    show();
    await user.click(screen.getByRole("button", { name: "End today" }));
    expect(block()!.end).toBe("2026-11-03");
    expect(lastToast().message).toBe("Knee rehab ended: its last day was yesterday");
    expect(rehab().querySelector('[data-rehab-block="knee"]')).toBeNull();
    expect(rehab().querySelector("[data-rehab-history] li")!.textContent).toBe("Knee rehabOct 19 – Nov 3 · 1 session");
    // A new block can start today now.
    expect(described(screen.getByRole("button", { name: "New rehab block" }))).toBe("Starts today.");
    // No rehab of it saved today: today's session is left alone.
    expect(store.sessionWrites).toEqual([]);
    undo();
    expect(block()).toEqual(knee());
    expect(store.sessionWrites).toEqual([]);
    expect(rehab().querySelector('[data-rehab-block="knee"]')).not.toBeNull();
  });

  it("End today with rehab logged today: today is its last day, and the card stays (without End today)", async () => {
    const user = userEvent.setup();
    reset(withRehab(knee()), [rehabSession(TODAY)]);
    show();
    await user.click(screen.getByRole("button", { name: "End today" }));
    expect(block()!.end).toBe(TODAY);
    expect(lastToast().message).toBe("Knee rehab ends today");
    expect(rehab().querySelector("[data-rehab-status]")!.textContent).toBe("Week 3 of 3 · Oct 19 – Nov 41 of 8 sessions logged");
    expect(screen.queryByRole("button", { name: "End today" })).toBeNull();
    // Logged today: today's session keeps its rehab and isn't written.
    expect(store.sessionWrites).toEqual([]);
    undo();
    expect(block()).toEqual(knee());
  });

  it("End today with today's rehab draft saved: the session loses it through the session save; Undo puts back only it, on the session as it is then", async () => {
    const user = userEvent.setup();
    const today = withStrength(draftOf(TODAY));
    reset(withRehab(knee()), [rehabSession("2026-10-19"), today]);
    show();
    await user.click(screen.getByRole("button", { name: "End today" }));
    expect(block()!.end).toBe("2026-11-03");
    expect(store.sessionWrites).toEqual([{ date: TODAY, doc: { ...today, blocks: [STRENGTH] } }]);
    // Meanwhile today's session changes on Train (a note): Undo keeps that.
    act(() => store.writeSession(TODAY, { ...store.data.sessions.find((s) => s.date === TODAY)!, notes: "sore" }));
    undo();
    expect(block()).toEqual(knee());
    expect(store.sessionWrites.at(-1)).toEqual({ date: TODAY, doc: { ...today, notes: "sore" } });
  });

  it("End today when today's session held only its rehab draft: the session is deleted; Undo saves it again", async () => {
    const user = userEvent.setup();
    const today = draftOf(TODAY);
    reset(withRehab(knee()), [rehabSession("2026-10-19"), today]);
    show();
    await user.click(screen.getByRole("button", { name: "End today" }));
    expect(store.sessionWrites).toEqual([{ date: TODAY, doc: null }]);
    expect(store.data.sessions.map((s) => s.date)).toEqual(["2026-10-19"]);
    undo();
    expect(block()).toEqual(knee());
    expect(store.sessionWrites.at(-1)).toEqual({ date: TODAY, doc: today });
  });

  it("End today's Undo, declined once the block was changed again since, leaves today's session too", async () => {
    const user = userEvent.setup();
    reset(withRehab(knee()), [rehabSession("2026-10-19"), withStrength(draftOf(TODAY))]);
    show();
    await user.click(screen.getByRole("button", { name: "End today" }));
    const other = structuredClone(store.data.settings);
    other.rehab!.programs[0]!.end = "2026-11-02";
    act(() => store.remote(other));
    undo();
    expect(lastToast()).toMatchObject({ message: "Can't undo: Knee rehab was changed again since.", tone: "warn" });
    expect(block()!.end).toBe("2026-11-02");
    expect(store.sessionWrites).toHaveLength(1);
  });

  it("Cancel while nothing is logged: the block goes; Undo puts it back", async () => {
    const user = userEvent.setup();
    reset(withRehab(knee()));
    show();
    await user.click(screen.getByRole("button", { name: "Cancel it" }));
    expect(programs()).toHaveLength(0);
    expect(lastToast().message).toBe("Knee rehab cancelled");
    undo();
    expect(block()).toEqual(knee());
  });

  it("a new block starts the day after the current one ends; an overlap is refused with its reason, saving nothing", async () => {
    const user = userEvent.setup();
    reset(withRehab(knee()));
    show();
    const add = screen.getByRole("button", { name: "New rehab block" });
    expect(described(add)).toBe("Starts Mon Nov 30, the day after Knee rehab ends — or today, if you end it first.");
    await user.click(add);
    const starts = screen.getByLabelText<HTMLInputElement>("Starts");
    expect(starts.value).toBe("2026-11-30");
    // It starts with the latest block's days and length.
    expect(day("New rehab block days", "Wed").getAttribute("aria-pressed")).toBe("true");
    await user.type(screen.getByRole("textbox", { name: "Name" }), "Hip rehab");
    fireEvent.change(starts, { target: { value: TODAY } });
    await user.click(screen.getByRole("button", { name: "Start it" }));
    expect(screen.getByRole("alert").textContent).toBe("Knee rehab runs until Nov 29: end it or start this one after.");
    expect(store.saved).toHaveLength(0);

    fireEvent.change(starts, { target: { value: "2026-11-30" } });
    await user.click(screen.getByRole("button", { name: "Start it" }));
    expect(programs().map((p) => [p.name, p.start])).toEqual([
      ["Knee rehab", "2026-10-19"],
      ["Hip rehab", "2026-11-30"],
    ]);
    // Scheduled after the one in force: its own card, under "Next rehab block".
    expect(within(rehab()).getByRole("heading", { level: 3, name: "Next rehab block" })).toBeTruthy();
    const next = rehab().querySelectorAll<HTMLElement>("[data-rehab-block]")[1]!;
    expect(next.querySelector("[data-rehab-status]")!.textContent).toBe("Starts Mon Nov 30 · Nov 30 – Jan 10, 202718 sessions planned");
    expect(within(next).queryByRole("button", { name: "End today" })).toBeNull();
    // The one in force can't run into it any more.
    expect(described(screen.getAllByRole("button", { name: "A week" })[0]!)).toBe("Hip rehab starts Nov 30: end this one before it.");
    expect(screen.getAllByRole("button", { name: "A week" })[0]!.hasAttribute("disabled")).toBe(true);
  });

  it("renaming it leaves an Undo that only puts the name back", async () => {
    const user = userEvent.setup();
    reset(withRehab(knee()));
    show();
    const name = screen.getByRole("textbox", { name: "Rehab block name" });
    await user.clear(name);
    await user.type(name, "Left knee{Enter}");
    expect(block()!.name).toBe("Left knee");
    expect(lastToast().message).toBe("Renamed Knee rehab to Left knee");
    const other = structuredClone(store.data.settings);
    other.rehab!.programs[0]!.weeks = 8;
    act(() => store.remote(other));
    undo();
    expect(block()).toEqual(knee({ weeks: 8 }));
  });
});
