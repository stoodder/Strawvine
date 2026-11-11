/**
 * The bottom nav's active tab: each tab is current on its own screen and on the screens it also
 * covers — Today on a past day (`/day/…`), Train on a Train day and on Program — and on Settings
 * none is.
 */
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { BottomNav } from "./BottomNav";
import { DockProvider } from "./Dock";

const TABS = ["Today", "Train", "Progress", "Goals"];

function currentAt(path: string): string[] {
  const view = render(
    <MemoryRouter initialEntries={[path]}>
      <DockProvider>
        <BottomNav />
      </DockProvider>
    </MemoryRouter>,
  );
  const links = within(screen.getByRole("navigation", { name: "Primary" })).getAllByRole("link");
  expect(links.map((a) => a.textContent)).toEqual(TABS);
  // Only "page" marks the current tab; anything else on a tab would be wrong too.
  for (const a of links) expect([null, "page"]).toContain(a.getAttribute("aria-current"));
  const current = links.filter((a) => a.getAttribute("aria-current") === "page").map((a) => a.textContent!);
  view.unmount();
  return current;
}

describe("BottomNav", () => {
  it.each([
    ["/", "Today"],
    ["/day/2026-10-19", "Today"],
    ["/train", "Train"],
    ["/train/2026-10-19", "Train"],
    ["/program", "Train"],
    ["/progress?view=body", "Progress"],
    ["/goals", "Goals"],
    ["/settings", null],
  ])("on %s the current tab is %s", (path, tab) => {
    expect(currentAt(path)).toEqual(tab ? [tab] : []);
  });

  it("links each tab to its screen", () => {
    render(
      <MemoryRouter initialEntries={["/program"]}>
        <DockProvider>
          <BottomNav />
        </DockProvider>
      </MemoryRouter>,
    );
    const hrefs = within(screen.getByRole("navigation", { name: "Primary" }))
      .getAllByRole("link")
      .map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual(["/", "/train", "/progress", "/goals"]);
  });
});
