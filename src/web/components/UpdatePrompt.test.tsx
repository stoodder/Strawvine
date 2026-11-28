import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { SyncState } from "../lib/sync";
import { DockProvider } from "./Dock";
import { UpdatePrompt } from "./UpdatePrompt";

const sync = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  let state = {
    pending: 0,
    failed: 0,
    failedMessage: null,
    online: true,
    sending: false,
    retrying: false,
    authPaused: false,
    restoring: false,
    outdated: false,
  };
  return {
    get: () => state,
    set: (over: Partial<SyncState>) => {
      state = { ...state, ...over } as typeof state;
      for (const l of listeners) l();
    },
    subscribe: (l: () => void) => (listeners.add(l), () => listeners.delete(l)),
  };
});
vi.mock("../lib/sync", () => ({ getSyncState: sync.get, subscribeSync: sync.subscribe, retryFailed: vi.fn(), discardFailed: vi.fn() }));
const updateApp = vi.hoisted(() => vi.fn(() => new Promise<void>(() => {})));
vi.mock("../lib/build", () => ({ updateApp }));

describe("UpdatePrompt", () => {
  it("appears in the dock once a change was refused as from an outdated build, stays, and updates the app on tap", async () => {
    render(
      <DockProvider>
        <UpdatePrompt />
      </DockProvider>,
    );
    expect(screen.queryByRole("button", { name: "Update the app" })).toBeNull();
    act(() => sync.set({ failed: 1, outdated: true }));
    const dock = screen.getByRole("region", { name: "Notifications" });
    expect(dock.querySelector('[data-dock-item="update"]')).not.toBeNull();
    expect(screen.getByRole("alert").textContent).toMatch(/Update needed\. This version can't save a change; it's kept on this device\./);
    // No way to dismiss it: the only control updates.
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Update the app"]);
    await userEvent.click(screen.getByRole("button", { name: "Update the app" }));
    expect(updateApp).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Updating…" })).toHaveProperty("disabled", true);
    // A discarded change doesn't make it go: the app is still out of date.
    act(() => sync.set({ failed: 0 }));
    expect(screen.getByRole("alert")).toBeTruthy();
  });
});
