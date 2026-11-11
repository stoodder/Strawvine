import { describe, expect, it } from "vitest";
import { safeString } from "./schemas";
import { hasIllFormedText, isWellFormed, isWellFormedByRegex } from "./text";

const WELL = ["", "plain", "é ñ 日本", "😀", "a💪b", "😀😀", "￿", "", "nul \u0000 is another rule"];
/** The engine's own check (ES2024; Node 20+), which the fallback must match. */
const native = (s: string) => (s as unknown as { isWellFormed(): boolean }).isWellFormed();
const ILL = ["\ud83d", "\ude00", "great \ud83d!", "\ude00 Push", "\ud83d😀", "😀\ude00", "\udbff", "\udc00\ud800"];

describe("well-formed text", () => {
  it("is text without half of a surrogate pair", () => {
    for (const s of WELL) expect(isWellFormed(s), JSON.stringify(s)).toBe(true);
    for (const s of ILL) expect(isWellFormed(s), JSON.stringify(s)).toBe(false);
  });

  it("the fallback for engines without String.prototype.isWellFormed agrees with it", () => {
    for (const s of [...WELL, ...ILL]) expect(isWellFormedByRegex(s), JSON.stringify(s)).toBe(native(s));
    // Every code unit alone, and around the surrogate ranges in pairs.
    for (let u = 0xd7f0; u <= 0xe010; u++) {
      const c = String.fromCharCode(u);
      for (const s of [c, `a${c}`, `${c}a`, `\ud83d${c}`, `${c}\ude00`]) expect(isWellFormedByRegex(s), u.toString(16)).toBe(native(s));
    }
  });

  it("is looked for in every string of a document, keys included", () => {
    expect(hasIllFormedText({ a: ["x", { b: "😀", n: 1, z: null }] })).toBe(false);
    expect(hasIllFormedText({ a: ["x", { b: "\ud83d" }] })).toBe(true);
    expect(hasIllFormedText({ "\ude00": 1 })).toBe(true);
    expect(hasIllFormedText(undefined)).toBe(false);
  });
});

describe("safeString", () => {
  const ok = (s: unknown) => safeString().max(40).safeParse(s).success;

  it("refuses what Postgres can't store: NUL and ill-formed text", () => {
    for (const s of WELL.filter((x) => !x.includes("\u0000"))) expect(ok(s), JSON.stringify(s)).toBe(true);
    for (const s of ILL) expect(ok(s), JSON.stringify(s)).toBe(false);
    expect(ok("nul \u0000")).toBe(false);
    expect(safeString().safeParse("great \ud83d").error!.issues[0]!.message).toBe("Must not contain a broken character (half of an emoji)");
  });

  it("still chains like a string schema (trim, min, max)", () => {
    expect(safeString().trim().min(1).max(3).safeParse("  ab  ").data).toBe("ab");
    expect(ok("x".repeat(41))).toBe(false);
  });
});
