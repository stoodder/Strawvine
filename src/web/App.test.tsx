/**
 * Boot: what the app shows before it has data — an offline state (never an endless splash), and
 * the sign-in screen (never cached data) on a device that isn't signed in.
 */
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { render, screen } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bootstrap, Settings } from "../shared/schemas";

vi.mock("./components/Toast", () => ({ showToast: vi.fn(() => 0) }));

let offline = false;
const loaded: Array<typeof import("./lib/sync")> = [];

beforeEach(() => {
  localStorage.clear();
  globalThis.indexedDB = new IDBFactory();
  offline = false;
  Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (offline) throw new TypeError("Failed to fetch");
      if (url.endsWith("/bootstrap")) return new Response(JSON.stringify(data), { status: 200, headers: { etag: '"1"' } });
      return new Response(JSON.stringify({ error: "nope" }), { status: 401 });
    }),
  );
});

afterEach(() => {
  for (const m of loaded.splice(0)) m.stopSync();
  vi.unstubAllGlobals();
});

const data: Bootstrap = {
  settings: { onboarded: true } as Settings,
  days: [],
  exercises: [],
  maxEntries: [],
  sessions: [],
  seenAchievements: [],
};

async function boot() {
  vi.resetModules();
  const sync = await import("./lib/sync");
  loaded.push(sync);
  await sync.initSync();
  const { App } = await import("./App");
  render(
    <QueryClientProvider client={sync.queryClient}>
      <App />
    </QueryClientProvider>,
  );
  return sync;
}

describe("boot", () => {
  it("offline with no copy on the device: says so, with the unsynced count and a retry", async () => {
    localStorage.setItem("strawvine:signed-in", "1");
    localStorage.setItem(
      "strawvine:outbox",
      JSON.stringify({
        entries: [{ seq: 1, op: { kind: "day", date: "2026-11-01", patch: { steps: 1 } }, state: "pending" }],
        nextSeq: 2,
        nextAck: 1,
        nextTemp: -1,
        tempMap: {},
      }),
    );
    offline = true;
    Object.defineProperty(navigator, "onLine", { value: false, configurable: true });
    await boot();
    expect(await screen.findByText("You're offline")).toBeTruthy();
    expect(screen.getByText(/1 unsynced change is safe on this device/)).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("a device that signed out shows sign-in, not the copy left on disk", async () => {
    // A copy on disk (e.g. from before sign-out existed), but no signed-in flag.
    localStorage.setItem("strawvine:signed-in", "1");
    vi.resetModules();
    const first = await import("./lib/sync");
    loaded.push(first);
    await first.initSync();
    await first.fetchBootstrap({ signal: new AbortController().signal });
    await first.persistNow();
    first.stopSync();
    localStorage.removeItem("strawvine:signed-in");

    offline = true;
    const sync = await boot();
    expect(localStorage.getItem("strawvine:signed-in")).toBeNull();
    expect(await screen.findByLabelText("Password")).toBeTruthy();
    expect(sync.currentData()).toBeUndefined();
  });
});
