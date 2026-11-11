/**
 * Progress among the other screens: the tab bar's Progress comes back to the view last shown this
 * session (SPEC §4.7), an explicit `?view=` and a fresh load of the bare path win over that memory,
 * and neither switching views nor the restore leaves entries in the history — Back leaves Progress.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { Link, MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addDays, dateRange } from "../../shared/dates";
import { defaultSettings } from "../../shared/defaults";
import { emptyDayLog } from "../../shared/empty";
import type { AppData } from "../../shared/gamify";
import { buildModel, weeklyVerdict } from "../../shared/insights";
import { recallProgressView, rememberProgressView } from "../components/progress/ViewTabs";
import { ProgressScreen } from "./Progress";

const TODAY = "2026-11-03";
const store = vi.hoisted(() => ({ data: null as unknown as AppData }));
// Only the week's view calls `weeklyVerdict`: a spy on it tells whether the week was ever rendered.
vi.mock("../../shared/insights", async (original) => {
  const actual = await original<typeof import("../../shared/insights")>();
  return { ...actual, weeklyVerdict: vi.fn(actual.weeklyVerdict) };
});
vi.mock("../lib/store", () => ({
  useData: () => ({ data: store.data, today: TODAY, model: buildModel(store.data, TODAY) }),
  useAddMax: () => vi.fn(),
  useDeleteMax: () => vi.fn(),
  useMarkSeen: () => vi.fn(),
}));
vi.mock("../components/Toast", () => ({ useToast: () => ({ show: vi.fn(() => 1), dismiss: vi.fn() }) }));

const KEY = "strawvine:progress-view";

/** The app's shell, reduced: a tab bar that outlives the screens (Today · Progress, as BottomNav links them), Back, and the URL. */
function Shell() {
  const { pathname, search } = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <nav>
        <Link to="/">Today tab</Link>
        <Link to="/progress">Progress tab</Link>
        <Link to="/progress?view=fuel">Fuel link</Link>
        <button type="button" onClick={() => navigate(-1)}>
          Back
        </button>
      </nav>
      <output data-testid="where">{pathname + search}</output>
    </>
  );
}
const app = (first = "/") =>
  render(
    <MemoryRouter initialEntries={[first]}>
      <Routes>
        <Route path="/" element={<h1>Today screen</h1>} />
        <Route path="/progress" element={<ProgressScreen />} />
      </Routes>
      <Shell />
    </MemoryRouter>,
  );
const where = () => screen.getByTestId("where").textContent;
const go = (name: string) => fireEvent.click(screen.getByRole(name === "Back" ? "button" : "link", { name }));
const tab = (name: string) => fireEvent.click(screen.getByRole("tab", { name }));
const selected = () =>
  screen
    .getAllByRole("tab")
    .filter((t) => t.getAttribute("aria-selected") === "true")
    .map((t) => t.textContent);
const panelHeading = () => screen.getByRole("tabpanel").querySelector("h2")!.textContent;

beforeEach(() => {
  sessionStorage.clear();
  store.data = {
    settings: { ...defaultSettings({ bench: 1, deadlift: 2, backSquat: 3, frontSquat: 4, strictPress: 5 }, "2026-10-01"), onboarded: true },
    days: dateRange(addDays(TODAY, -21), addDays(TODAY, -1)).map((date) => ({ ...emptyDayLog(date), weightLb: 200, calories: 2800 })),
    exercises: [],
    maxEntries: [],
    sessions: [],
    seenAchievements: [],
  } as AppData;
});
afterEach(() => vi.restoreAllMocks());

describe("Progress remembers its view for the session", () => {
  it("the first visit is the week", () => {
    app();
    go("Progress tab");
    expect(selected()).toEqual(["Week"]);
    expect(where()).toBe("/progress");
  });

  it("coming back from another tab restores the view last shown, in the URL too", () => {
    app();
    go("Progress tab");
    tab("Body");
    expect(sessionStorage.getItem(KEY)).toBe("body");
    go("Today tab");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Today screen");
    go("Progress tab");
    expect(selected()).toEqual(["Body"]);
    expect(panelHeading()).toBe("Bodyweight");
    expect(where()).toBe("/progress?view=body");
    // …and again, after moving on to another view.
    tab("Strength");
    go("Today tab");
    go("Progress tab");
    expect(selected()).toEqual(["Strength"]);
    expect(where()).toBe("/progress?view=strength");
  });

  it("the restored view is there on the first render — the week never flashes first", () => {
    rememberProgressView("body");
    app();
    vi.mocked(weeklyVerdict).mockClear();
    go("Progress tab");
    expect(panelHeading()).toBe("Bodyweight");
    expect(weeklyVerdict).not.toHaveBeenCalled();
    // (The spy does see the week when it is shown.)
    tab("Week");
    expect(weeklyVerdict).toHaveBeenCalled();
  });

  it("a restore is over once the URL has the view: Progress tapped again from there goes to the week", () => {
    rememberProgressView("activity");
    app();
    go("Progress tab");
    expect(where()).toBe("/progress?view=activity");
    go("Progress tab");
    expect(selected()).toEqual(["Week"]);
    expect(where()).toBe("/progress");
    expect(panelHeading()).toBe("Weekly check-in");
  });

  it("choosing Week is remembered like any other view", () => {
    app();
    go("Progress tab");
    tab("Fuel");
    tab("Week");
    expect(sessionStorage.getItem(KEY)).toBe("week");
    go("Today tab");
    go("Progress tab");
    expect(selected()).toEqual(["Week"]);
    expect(where()).toBe("/progress");
  });

  it("an explicit ?view= always wins over the memory, and becomes it", () => {
    rememberProgressView("body");
    app();
    go("Fuel link");
    expect(selected()).toEqual(["Fuel"]);
    expect(where()).toBe("/progress?view=fuel");
    go("Today tab");
    go("Progress tab");
    expect(selected()).toEqual(["Fuel"]);
    expect(where()).toBe("/progress?view=fuel");
  });

  it("an explicit ?view=week is the week, whatever was remembered", () => {
    rememberProgressView("strength");
    render(
      <MemoryRouter initialEntries={["/", "/progress?view=week"]} initialIndex={1}>
        <Routes>
          <Route path="/progress" element={<ProgressScreen />} />
        </Routes>
        <Shell />
      </MemoryRouter>,
    );
    expect(selected()).toEqual(["Week"]);
    expect(where()).toBe("/progress?view=week");
  });

  it("tapping Progress while on Progress goes to the week (no screen is mounted, nothing is restored)", () => {
    app();
    go("Progress tab");
    tab("Activity");
    expect(where()).toBe("/progress?view=activity");
    go("Progress tab");
    expect(selected()).toEqual(["Week"]);
    expect(where()).toBe("/progress");
    // The week is now what is remembered.
    go("Today tab");
    go("Progress tab");
    expect(selected()).toEqual(["Week"]);
  });

  it("a fresh load of the bare path is the week: a link or a typed URL, not a return", () => {
    rememberProgressView("body");
    app("/progress");
    expect(selected()).toEqual(["Week"]);
    expect(where()).toBe("/progress");
    expect(panelHeading()).toBe("Weekly check-in");
  });

  it("Back to a bare /progress entry shows what that entry was — the week — not the view remembered since", () => {
    app();
    go("Progress tab"); // an entry on the week
    go("Today tab");
    go("Progress tab"); // another, which moves on to Body
    tab("Body");
    expect(sessionStorage.getItem(KEY)).toBe("body");
    go("Back"); // Today
    expect(where()).toBe("/");
    go("Back"); // the first Progress entry
    expect(where()).toBe("/progress");
    expect(selected()).toEqual(["Week"]);
    expect(panelHeading()).toBe("Weekly check-in");
  });

  it("without session storage it simply opens on the week", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    expect(recallProgressView()).toBeNull();
    expect(() => rememberProgressView("body")).not.toThrow();
    app();
    go("Progress tab");
    tab("Body");
    expect(where()).toBe("/progress?view=body");
    go("Today tab");
    go("Progress tab");
    expect(selected()).toEqual(["Week"]);
    expect(where()).toBe("/progress");
  });

  it("a remembered value that names no view is forgotten", () => {
    sessionStorage.setItem(KEY, "calendar");
    expect(recallProgressView()).toBeNull();
    app();
    go("Progress tab");
    expect(selected()).toEqual(["Week"]);
    expect(where()).toBe("/progress");
    rememberProgressView("activity");
    expect(recallProgressView()).toBe("activity");
  });
});

describe("Progress leaves no trail in the history", () => {
  it("views replace one another: Back after Body → Fuel leaves Progress", () => {
    app();
    go("Progress tab");
    tab("Body");
    tab("Fuel");
    expect(where()).toBe("/progress?view=fuel");
    go("Back");
    expect(where()).toBe("/");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Today screen");
  });

  it("the restore replaces the bare path too: Back from a restored view leaves Progress, it doesn't bounce", () => {
    rememberProgressView("strength");
    app();
    go("Progress tab");
    expect(where()).toBe("/progress?view=strength");
    go("Back");
    expect(where()).toBe("/");
    expect(screen.queryByRole("tablist")).toBeNull();
  });

  it("keyboard selection replaces as well", () => {
    app();
    go("Progress tab");
    const week = screen.getByRole("tab", { name: "Week" });
    week.focus();
    fireEvent.keyDown(week, { key: "ArrowRight" });
    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    expect(where()).toBe("/progress?view=fuel");
    go("Back");
    expect(where()).toBe("/");
  });
});
