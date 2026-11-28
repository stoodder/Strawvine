/** Feature flags: off by default, opted into per device through localStorage, never throwing. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyFlagParam, feature, features, FLAGS_KEY, parseFlags, setFeatures } from "./features";

class MemoryStorage {
  map = new Map<string, string>();
  getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, String(v));
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
}

let store: MemoryStorage;
beforeEach(() => {
  store = new MemoryStorage();
  vi.stubGlobal("window", { localStorage: store });
});
afterEach(() => vi.unstubAllGlobals());

describe("features", () => {
  it("are all off by default", () => {
    expect(features()).toEqual({ trainDay: false, rehab: false });
    expect(feature("trainDay")).toBe(false);
    expect(feature("rehab")).toBe(false);
  });

  it("read a list or JSON from localStorage, ignoring unknown names", () => {
    store.setItem(FLAGS_KEY, "trainDay, nonsense");
    expect(features()).toEqual({ trainDay: true, rehab: false });
    store.setItem(FLAGS_KEY, '{"rehab":true,"trainDay":false,"x":true}');
    expect(features()).toEqual({ trainDay: false, rehab: true });
    store.setItem(FLAGS_KEY, '["trainDay","rehab"]');
    expect(features()).toEqual({ trainDay: true, rehab: true });
  });

  it("read malformed values as off", () => {
    for (const raw of ["{not json", '{"trainDay":"yes"}', "TRAINDAY", "", "   ", null])
      expect(parseFlags(raw)).toEqual({ trainDay: false, rehab: false });
  });

  it("set one flag and keep the others; turning all off removes the key", () => {
    expect(setFeatures({ rehab: true })).toBe(true);
    expect(store.getItem(FLAGS_KEY)).toBe("rehab");
    setFeatures({ trainDay: true });
    expect(features()).toEqual({ trainDay: true, rehab: true });
    setFeatures({ trainDay: false, rehab: false });
    expect(store.getItem(FLAGS_KEY)).toBeNull();
  });

  it("never throw when storage does: everything reads as off and writes report failure", () => {
    vi.stubGlobal("window", {
      get localStorage(): Storage {
        throw new Error("SecurityError");
      },
    });
    expect(features()).toEqual({ trainDay: false, rehab: false });
    expect(feature("rehab")).toBe(false);
    expect(setFeatures({ rehab: true })).toBe(false);

    vi.stubGlobal("window", {
      localStorage: {
        getItem: () => {
          throw new Error("blocked");
        },
        setItem: () => {
          throw new Error("QuotaExceededError");
        },
        removeItem: () => {},
      },
    });
    expect(feature("trainDay")).toBe(false);
    expect(setFeatures({ trainDay: true })).toBe(false);
  });

  it("are off with no window at all (server, worker)", () => {
    vi.stubGlobal("window", undefined);
    expect(features()).toEqual({ trainDay: false, rehab: false });
  });

  it("can be set from a ?flags= query, which is then dropped from the query", () => {
    expect(applyFlagParam("?tab=x")).toBeNull();
    expect(applyFlagParam("?flags=trainDay,rehab&tab=x")).toBe("?tab=x");
    expect(features()).toEqual({ trainDay: true, rehab: true });
    expect(applyFlagParam("?flags=rehab")).toBe("");
    expect(features()).toEqual({ trainDay: false, rehab: true });
    expect(applyFlagParam("?flags=")).toBe("");
    expect(store.getItem(FLAGS_KEY)).toBeNull();
  });
});
