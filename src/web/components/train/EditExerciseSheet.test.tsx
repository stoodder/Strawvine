/**
 * The Edit exercise sheet, opened from Settings' exercise library: prefilled from the exercise,
 * sends only what changed, keeps a program's main lift intact, archives with an undo.
 */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultSettings } from "../../../shared/defaults";
import type { Exercise, Settings } from "../../../shared/schemas";
import { MemoryRouter } from "react-router";
import { LiftsEditor } from "../program/LiftsEditor";

const store = vi.hoisted(() => ({
  exercises: [] as Exercise[],
  settings: null as unknown as Settings,
  edit: vi.fn(),
  toast: vi.fn(),
}));
vi.mock("../../lib/store", () => ({
  useData: () => ({ data: { exercises: store.exercises, settings: store.settings } }),
  useEditExercise: () => store.edit,
  useCreateExercise: () => vi.fn(),
}));
vi.mock("../Toast", () => ({ useToast: () => ({ show: store.toast, dismiss: vi.fn() }) }));

const root = () => document.getElementById("root")!;
/** The library in a router (the lock note links to the program settings). */
const renderLibrary = () =>
  render(
    <MemoryRouter>
      <LiftsEditor />
    </MemoryRouter>,
    { container: root() },
  );
const exercise = (o: Partial<Exercise> & Pick<Exercise, "id" | "name">): Exercise => ({
  category: "accessory",
  tracksMax: false,
  measure: "reps",
  weighted: true,
  archived: false,
  ...o,
});

beforeEach(() => {
  store.edit.mockClear();
  store.toast.mockClear();
  // The default program: bench on Monday, deadlift Tuesday, back squat Wednesday, strict press Thursday.
  store.settings = defaultSettings({ bench: 1, deadlift: 2, backSquat: 3, frontSquat: 4, strictPress: 5 }, "2026-11-02");
  store.exercises = [
    exercise({ id: 1, name: "Bench press", category: "primary", tracksMax: true }),
    exercise({ id: 4, name: "Front squat", category: "primary", tracksMax: true }),
    exercise({ id: 10, name: "Weighted dead hang", measure: "seconds" }),
    exercise({ id: 11, name: "Pull-up", weighted: false }),
    exercise({ id: 12, name: "Sled push", archived: true }),
  ];
});

const open = async (name: string) => {
  const user = userEvent.setup();
  const r = renderLibrary();
  await user.click(screen.getByRole("button", { name: `Edit ${name}` }));
  const dialog = screen.getByRole("dialog", { name: `Edit ${name}` });
  const rerender = () =>
    r.rerender(
      <MemoryRouter>
        <LiftsEditor />
      </MemoryRouter>,
    );
  return { user, dialog, q: within(dialog), rerender };
};
const pressed = (group: HTMLElement, name: string) => within(group).getByRole("button", { name }).getAttribute("aria-pressed");

describe("Settings' exercise library", () => {
  it("lists each exercise with its tag, archived ones on request", async () => {
    const user = userEvent.setup();
    renderLibrary();
    expect(screen.getByRole("button", { name: "Edit Weighted dead hang", description: "Accessory · time · weighted" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Edit Bench press", description: "Barbell · max" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Edit Pull-up", description: "Accessory" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Edit Sled push" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "show archived" }));
    expect(screen.getByRole("button", { name: "Edit Sled push", description: "Accessory · weighted · archived" })).toBeTruthy();
  });
});

describe("Edit exercise", () => {
  it("starts from the exercise as it is, and saves nothing until something changes", async () => {
    const { q } = await open("Weighted dead hang");
    expect((q.getByRole("textbox", { name: "Name" }) as HTMLInputElement).value).toBe("Weighted dead hang");
    expect(pressed(q.getByRole("group", { name: "Category" }), "Accessory")).toBe("true");
    expect(pressed(q.getByRole("group", { name: "Measured in" }), "Time")).toBe("true");
    expect(pressed(q.getByRole("group", { name: "Load" }), "Weighted")).toBe("true");
    expect(pressed(q.getByRole("group", { name: "Max" }), "Not tracked")).toBe("true");
    expect(q.getByRole("button", { name: "Save" })).toHaveProperty("disabled", true);
  });

  it("sends only the changed fields, as one patch", async () => {
    const { user, q } = await open("Weighted dead hang");
    const name = q.getByRole("textbox", { name: "Name" });
    await user.clear(name);
    await user.type(name, "Dead hang ");
    await user.click(within(q.getByRole("group", { name: "Category" })).getByRole("button", { name: "Core" }));
    await user.click(within(q.getByRole("group", { name: "Measured in" })).getByRole("button", { name: "Distance" }));
    await user.click(within(q.getByRole("group", { name: "Measured in" })).getByRole("button", { name: "Reps" }));
    expect(q.getByText("Past sessions stay in seconds · new sets start at 10 reps")).toBeTruthy();
    await user.click(q.getByRole("button", { name: "Save" }));
    expect(store.edit).toHaveBeenCalledTimes(1);
    expect(store.edit).toHaveBeenCalledWith(10, { name: "Dead hang", category: "core", measure: "reps" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(store.toast).not.toHaveBeenCalled();
  });

  it("making it unweighted says the logged loads are kept, with an undo", async () => {
    const { user, q } = await open("Weighted dead hang");
    await user.click(q.getByRole("button", { name: "Unweighted" }));
    expect(q.getByRole("group", { name: "Load", description: "No load — just the time · logged loads are kept" })).toBeTruthy();
    await user.click(q.getByRole("button", { name: "Save" }));
    expect(store.edit).toHaveBeenCalledWith(10, { weighted: false });
    const toast = store.toast.mock.calls[0]![0] as { message: string; action: { label: string; onAction: () => void } };
    expect(toast.message).toBe("Weighted dead hang no longer tracks load — logged loads are kept");
    toast.action.onAction();
    expect(store.edit).toHaveBeenLastCalledWith(10, { weighted: true });
  });

  it("needs a name", async () => {
    const { user, q } = await open("Pull-up");
    await user.clear(q.getByRole("textbox", { name: "Name" }));
    expect(q.getByText("An exercise needs a name.")).toBeTruthy();
    expect(q.getByRole("button", { name: "Save" })).toHaveProperty("disabled", true);
    await user.keyboard("{Enter}");
    expect(store.edit).not.toHaveBeenCalled();
  });

  it("offers no load choice on a main lift, and turning max tracking on makes a lift weighted", async () => {
    const { user, q } = await open("Pull-up");
    expect(pressed(q.getByRole("group", { name: "Load" }), "Unweighted")).toBe("true");
    await user.click(within(q.getByRole("group", { name: "Max" })).getByRole("button", { name: "Tracked" }));
    expect(q.queryByRole("group", { name: "Load" })).toBeNull();
    await user.click(q.getByRole("button", { name: "Save" }));
    expect(store.edit).toHaveBeenCalledWith(11, { tracksMax: true, weighted: true });
  });

  it("keeps a program's main lift intact: category, measure and max locked, no archiving — the name is free", async () => {
    const { user, q } = await open("Bench press");
    const note =
      "Mon’s main lift: the program calculates it from its max, so its category, measure and max stay as they are and it can’t be archived. Change the weekly layout to free them.";
    expect(q.getByText((_, el) => el?.tagName === "P" && el.textContent === note)).toBeTruthy();
    expect(q.getByRole("link", { name: "weekly layout" }).getAttribute("href")).toBe("/program#layout");
    for (const group of ["Category", "Measured in", "Max"]) {
      const g = q.getByRole("group", { name: group, description: note });
      // Locked, not disabled: still reached by Tab (and with them the note); a press changes nothing.
      for (const b of within(g).getAllByRole("button")) {
        expect(b.getAttribute("aria-disabled")).toBe("true");
        expect(b).toHaveProperty("disabled", false);
      }
    }
    await user.click(within(q.getByRole("group", { name: "Category" })).getByRole("button", { name: "Core" }));
    expect(pressed(q.getByRole("group", { name: "Category" }), "Barbell")).toBe("true");
    expect(q.queryByRole("group", { name: "Load" })).toBeNull();
    const archive = q.getByRole("button", { name: "Archive", description: note });
    expect(archive.getAttribute("aria-disabled")).toBe("true");
    archive.focus();
    expect(document.activeElement).toBe(archive);
    await user.click(archive);
    expect(store.edit).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeTruthy();
    await user.type(q.getByRole("textbox", { name: "Name" }), " (comp)");
    await user.click(q.getByRole("button", { name: "Save" }));
    expect(store.edit).toHaveBeenCalledWith(1, { name: "Bench press (comp)" });
  });

  it("tabs through the locked chips", async () => {
    const { user, q } = await open("Bench press");
    q.getByRole("textbox", { name: "Name" }).focus();
    await user.tab(); // the note's link
    await user.tab();
    expect(document.activeElement).toBe(within(q.getByRole("group", { name: "Category" })).getByRole("button", { name: "Accessory" }));
  });

  it("leaves a tracked lift the program doesn't use editable", async () => {
    const { user, q } = await open("Front squat");
    expect(within(q.getByRole("group", { name: "Category" })).getByRole("button", { name: "Accessory" })).toHaveProperty("disabled", false);
    await user.click(within(q.getByRole("group", { name: "Max" })).getByRole("button", { name: "Not tracked" }));
    await user.click(within(q.getByRole("group", { name: "Category" })).getByRole("button", { name: "Accessory" }));
    // No longer a main lift: the load is a choice again, starting from weighted.
    expect(pressed(q.getByRole("group", { name: "Load" }), "Weighted")).toBe("true");
    await user.click(q.getByRole("button", { name: "Save" }));
    expect(store.edit).toHaveBeenCalledWith(4, { category: "accessory", tracksMax: false });
  });

  it("keeps max tracking on for a lift with a strength target", async () => {
    store.settings = { ...store.settings, strengthTargets: [{ id: "t", exerciseId: 4, targetLb: 405, setOn: "2026-11-02" }] };
    const { q } = await open("Front squat");
    const max = q.getByRole("group", { name: "Max", description: "A strength target follows its max" });
    expect(within(max).getByRole("button", { name: "Not tracked" }).getAttribute("aria-disabled")).toBe("true");
  });

  it("archives with an undo — sending only `archived`, whatever else the form holds — and restores", async () => {
    const { user, q } = await open("Pull-up");
    await user.click(within(q.getByRole("group", { name: "Category" })).getByRole("button", { name: "Core" }));
    await user.type(q.getByRole("textbox", { name: "Name" }), "s");
    await user.click(q.getByRole("button", { name: "Archive" }));
    expect(store.edit).toHaveBeenCalledTimes(1);
    expect(store.edit).toHaveBeenCalledWith(11, { archived: true });
    const toast = store.toast.mock.calls[0]![0] as { message: string; action: { onAction: () => void } };
    expect(toast.message).toBe("Pull-up archived");
    toast.action.onAction();
    expect(store.edit).toHaveBeenLastCalledWith(11, { archived: false });

    await user.click(screen.getByRole("button", { name: "show archived" }));
    await user.click(screen.getByRole("button", { name: "Edit Sled push" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Restore" }));
    expect(store.edit).toHaveBeenLastCalledWith(12, { archived: false });
  });

  it("after archiving a row out of the list, focus moves to the next row (else the one before)", async () => {
    store.edit.mockImplementation((id: number, patch: Partial<Exercise>) => {
      store.exercises = store.exercises.map((e) => (e.id === id ? { ...e, ...patch } : e));
    });
    const first = await open("Weighted dead hang");
    await first.user.click(first.q.getByRole("button", { name: "Archive" }));
    first.rerender();
    expect(screen.queryByRole("button", { name: "Edit Weighted dead hang" })).toBeNull();
    await vi.waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Edit Pull-up" })));

    // The last row: the one before it.
    await first.user.click(screen.getByRole("button", { name: "Edit Pull-up" }));
    await first.user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Archive" }));
    first.rerender();
    await vi.waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Edit Front squat" })));
    store.edit.mockReset();
  });

  it("asks before dropping unsaved changes (Escape, the backdrop, Close), and keeps them on request", async () => {
    const { user, q } = await open("Pull-up");
    // Nothing changed: Escape just closes.
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Edit Pull-up" }));
    const d = within(screen.getByRole("dialog", { name: "Edit Pull-up" }));
    await user.click(within(d.getByRole("group", { name: "Category" })).getByRole("button", { name: "Core" }));
    await user.keyboard("{Escape}");
    const confirm = d.getByRole("group", { name: "Discard changes?" });
    expect(document.activeElement).toBe(within(confirm).getByRole("button", { name: "Keep editing" }));
    // Escape again (or Keep editing) goes back to the form, changes intact.
    await user.keyboard("{Escape}");
    expect(d.queryByRole("group", { name: "Discard changes?" })).toBeNull();
    expect(pressed(d.getByRole("group", { name: "Category" }), "Core")).toBe("true");
    await user.click(d.getByRole("button", { name: "Close" }));
    await user.click(d.getByRole("button", { name: "Keep editing" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(pressed(d.getByRole("group", { name: "Category" }), "Core")).toBe("true");
    // The backdrop asks too; Discard closes without saving.
    await user.click(document.querySelector<HTMLElement>(".backdrop-blur-sm")!);
    await user.click(d.getByRole("button", { name: "Discard" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(store.edit).not.toHaveBeenCalled();
    void q;
  });

  it("Enter in an unchanged name neither saves nor closes", async () => {
    const { user, q } = await open("Pull-up");
    await user.click(q.getByRole("textbox", { name: "Name" }));
    await user.keyboard("{Enter}");
    expect(screen.getByRole("dialog", { name: "Edit Pull-up" })).toBeTruthy();
    expect(store.edit).not.toHaveBeenCalled();
    // Changed, Enter saves.
    await user.type(q.getByRole("textbox", { name: "Name" }), "s{Enter}");
    expect(store.edit).toHaveBeenCalledWith(11, { name: "Pull-ups" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("starts over when closed without saving", async () => {
    const { user, q } = await open("Pull-up");
    await user.click(within(q.getByRole("group", { name: "Category" })).getByRole("button", { name: "Core" }));
    await user.click(q.getByRole("button", { name: "Close" }));
    await user.click(q.getByRole("button", { name: "Discard" }));
    await user.click(screen.getByRole("button", { name: "Edit Pull-up" }));
    const again = within(screen.getByRole("dialog", { name: "Edit Pull-up" }));
    expect(pressed(again.getByRole("group", { name: "Category" }), "Accessory")).toBe("true");
    expect(store.edit).not.toHaveBeenCalled();
  });
});
