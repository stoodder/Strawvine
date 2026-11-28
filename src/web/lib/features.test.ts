/** Feature flags: off by default, opted into per device through localStorage, never throwing. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyFlagParam, feature, features, flagNotice, FLAGS_KEY, parseFlagChanges, parseFlags, setFeatures } from "./features";

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

  it("?flags= merges into this device's flags — a name on, -name off, empty changes nothing — and is dropped from the query", () => {
    expect(applyFlagParam("?tab=x")).toBeNull();
    expect(applyFlagParam("?flags=trainDay,rehab&tab=x")).toEqual({
      rest: "?tab=x",
      changed: { trainDay: true, rehab: true },
      saved: true,
    });
    expect(features()).toEqual({ trainDay: true, rehab: true });
    // Merged, not replaced: rehab alone keeps trainDay.
    expect(applyFlagParam("?flags=rehab")).toEqual({ rest: "", changed: { rehab: true }, saved: true });
    expect(features()).toEqual({ trainDay: true, rehab: true });
    expect(applyFlagParam("?flags=-trainDay")).toEqual({ rest: "", changed: { trainDay: false }, saved: true });
    expect(features()).toEqual({ trainDay: false, rehab: true });
    // Empty (or nothing known): no change at all.
    expect(applyFlagParam("?flags=")).toEqual({ rest: "", changed: {}, saved: true });
    expect(applyFlagParam("?flags=nonsense")).toEqual({ rest: "", changed: {}, saved: true });
    expect(features()).toEqual({ trainDay: false, rehab: true });
    // "+rehab" in a URL reads as " rehab"; "+" spelt out works too.
    expect(applyFlagParam("?flags=%2BtrainDay,-rehab")!.changed).toEqual({ trainDay: true, rehab: false });
    expect(applyFlagParam("?flags=+rehab")!.changed).toEqual({ rehab: true });
    expect(store.getItem(FLAGS_KEY)).toBe("trainDay,rehab");
    expect(applyFlagParam("?flags=-trainDay,-rehab")!.changed).toEqual({ trainDay: false, rehab: false });
    expect(store.getItem(FLAGS_KEY)).toBeNull();
  });

  it("?flags= says when storage refused it", () => {
    vi.stubGlobal("window", {
      localStorage: {
        getItem: () => null,
        setItem: () => {
          throw new Error("QuotaExceededError");
        },
        removeItem: () => {},
      },
    });
    expect(applyFlagParam("?flags=rehab")).toEqual({ rest: "", changed: { rehab: true }, saved: false });
  });

  it("parse ?flags= changes: names, -names, unknown ones ignored", () => {
    expect(parseFlagChanges("rehab, -trainDay x -y")).toEqual({ rehab: true, trainDay: false });
    expect(parseFlagChanges("")).toEqual({});
    expect(parseFlagChanges(null)).toEqual({});
  });

  it("say what changed, for this device — or that storage refused it", () => {
    expect(flagNotice({ rehab: true }, true)).toBe("Rehab preview on for this device");
    expect(flagNotice({ trainDay: false }, true)).toBe("New Train preview off for this device");
    expect(flagNotice({ trainDay: true, rehab: true }, true)).toBe("New Train and Rehab previews on for this device");
    expect(flagNotice({ rehab: true, trainDay: false }, true)).toBe("Rehab preview on, New Train preview off for this device");
    expect(flagNotice({ rehab: true }, false)).toBe("Couldn't change the Rehab preview: this device didn't let Strawvine save it");
    expect(flagNotice({}, true)).toBeNull();
  });
});
