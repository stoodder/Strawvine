import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  retrying: false,
  info: { online: true, pending: 2, failed: 0, unsynced: 2, lastSyncedAt: null, items: [] as unknown[] },
  resolve: null as null | (() => void),
  syncNow: vi.fn(),
}));
vi.mock("../../lib/store", () => ({
  useSyncInfo: () => ({ ...state.info, syncNow: state.syncNow, retryFailed: () => {}, discardFailed: () => {} }),
}));

vi.mock("../SyncStatus", () => ({ useSyncState: () => ({ retrying: state.retrying }) }));

import { PendingSyncChip } from "./PendingSyncChip";

describe("PendingSyncChip", () => {
  beforeEach(() => {
    state.info = { online: true, pending: 2, failed: 0, unsynced: 2, lastSyncedAt: null, items: [] };
    state.retrying = false;
    state.syncNow.mockReset();
    state.syncNow.mockImplementation(() => new Promise<void>((r) => (state.resolve = r)));
  });

  it("is quiet when the day has nothing pending", () => {
    render(<PendingSyncChip pending={false} />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("shows the count, syncs on tap (spinner), then ticks 'synced' once the day is clear", async () => {
    const { rerender } = render(<PendingSyncChip pending />);
    const chip = screen.getByRole("button", { name: /^2 unsynced/ });
    act(() => chip.click());
    expect(state.syncNow).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Syncing" })).toBeTruthy();
    // Tapping again while it runs doesn't start another.
    act(() => screen.getByRole("button", { name: "Syncing" }).click());
    expect(state.syncNow).toHaveBeenCalledTimes(1);

    state.info = { ...state.info, pending: 0, unsynced: 0 };
    rerender(<PendingSyncChip pending={false} />);
    await act(async () => state.resolve!());
    expect(screen.getByRole("button", { name: "Synced" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("All changes synced");
  });

  it("goes back to the count when the sync didn't clear the day", async () => {
    render(<PendingSyncChip pending />);
    act(() => screen.getByRole("button", { name: /unsynced/ }).click());
    await act(async () => state.resolve!());
    expect(screen.getByRole("button", { name: /^2 unsynced/ })).toBeTruthy();
  });

  it("offline: says so and can't be tapped", () => {
    state.info = { ...state.info, online: false };
    render(<PendingSyncChip pending />);
    const chip = screen.getByRole("button", { name: /^2 offline/ });
    expect((chip as HTMLButtonElement).disabled).toBe(true);
  });

  it("takes the warn tone while the server can't be reached", () => {
    state.retrying = true;
    render(<PendingSyncChip pending />);
    const chip = screen.getByRole("button", { name: /^2 unsynced\. Can't reach the server/ });
    expect(chip.className).toContain("text-warn");
  });

  it("hands focus to the fallback when it goes away while focused", () => {
    const target = document.createElement("input");
    document.body.append(target);
    const { rerender } = render(<PendingSyncChip pending focusFallback={() => target} />);
    const chip = screen.getByRole("button", { name: /^2 unsynced/ });
    chip.focus();
    expect(document.activeElement).toBe(chip);
    state.info = { ...state.info, pending: 0, unsynced: 0 };
    rerender(<PendingSyncChip pending={false} focusFallback={() => target} />);
    expect(document.activeElement).toBe(target);
    target.remove();
  });
});
