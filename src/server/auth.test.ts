import { describe, expect, it } from "vitest";
import { clientKey, deriveSessionKey, loginLimiter, makeToken, readToken } from "./auth";

describe("session tokens", () => {
  const key = deriveSessionKey("s".repeat(40), "hunter2");

  it("round-trips expiry and epoch, and rejects tampering", () => {
    const now = 1_800_000_000_000;
    const token = makeToken(key, 3, now);
    expect(readToken(token, key, now)).toMatchObject({ epoch: 3 });
    expect(readToken(token.replace(".3.", ".4."), key, now)).toBeNull();
    expect(readToken(token, deriveSessionKey("s".repeat(40), "hunter3"), now)).toBeNull();
    expect(readToken(token, key, now + 181 * 86_400_000)).toBeNull();
    expect(readToken("123.abc", key, now)).toBeNull();
    expect(readToken(undefined, key, now)).toBeNull();
  });
});

describe("session keys", () => {
  it("mixes the database salt in, keeping the unsalted key for older databases", () => {
    const legacy = deriveSessionKey("s".repeat(40), "hunter2");
    expect(deriveSessionKey("s".repeat(40), "hunter2", "")).toEqual(legacy);
    const a = deriveSessionKey("s".repeat(40), "hunter2", "salt-a");
    expect(a).not.toEqual(legacy);
    expect(a).not.toEqual(deriveSessionKey("s".repeat(40), "hunter2", "salt-b"));
    expect(readToken(makeToken(a, 1), deriveSessionKey("s".repeat(40), "hunter2", "salt-b"))).toBeNull();
  });
});

describe("client keys", () => {
  it("groups IPv4 by /24 and IPv6 by /64", () => {
    expect(clientKey("203.0.113.7")).toBe("203.0.113.0/24");
    expect(clientKey("::ffff:203.0.113.200")).toBe("203.0.113.0/24");
    expect(clientKey("2001:db8:1:2:3:4:5:6")).toBe("2001:db8:1:2::/64");
    expect(clientKey("2001:db8:1:2::9")).toBe("2001:db8:1:2::/64");
    expect(clientKey("2001:0db8::1")).toBe("2001:db8:0:0::/64");
    expect(clientKey("::1")).toBe("0:0:0:0::/64");
    expect(clientKey("unknown")).toBe("unknown");
  });
});

describe("login limiter", () => {
  it("counts only failures, per client", () => {
    const l = loginLimiter({ perClient: 3, global: 100 });
    for (let i = 0; i < 3; i++) l.fail("a", 1000);
    expect(l.blocked("a", 1000)).toBe(true);
    expect(l.blocked("b", 1000)).toBe(false);
    expect(l.blocked("a", 1000 + 15 * 60_000)).toBe(false);
  });

  it("slows unknown clients down under a distributed attack instead of locking everyone out", () => {
    const l = loginLimiter({ perClient: 10, global: 5, globalWindowMs: 60 * 60_000, baseDelayMs: 500, maxDelayMs: 10_000 });
    for (let i = 0; i < 5; i++) l.fail(`10.0.${i}.0/24`, 1000);
    // The 6th failure overall: a delay, doubling with each further failure…
    expect(l.check("10.0.99.0/24", {}, 2000)).toEqual({ ok: true, waitMs: 500 });
    l.fail("10.0.99.0/24", 2000);
    expect(l.check("10.0.98.0/24", {}, 10_000)).toEqual({ ok: true, waitMs: 1000 });
    l.fail("10.0.98.0/24", 10_000);
    // …serialised: concurrent attempts queue behind each other, and are refused past the cap.
    for (let i = 0; i < 3; i++) l.fail(`10.1.${i}.0/24`, 20_000);
    expect(l.check("a", {}, 20_000)).toEqual({ ok: true, waitMs: 10_000 });
    const next = l.check("b", {}, 20_000);
    expect(next.ok).toBe(false);
    // Known devices skip the tarpit entirely.
    expect(l.check("device:abc", { known: true }, 20_000)).toEqual({ ok: true, waitMs: 0 });
    // The window passes: back to normal.
    expect(l.check("c", {}, 1000 + 60 * 60_000 + 30_000)).toEqual({ ok: true, waitMs: 0 });
  });

  it("still blocks a single client after its own failures, known device or not", () => {
    const l = loginLimiter({ perClient: 2 });
    l.fail("device:abc", 0);
    l.fail("device:abc", 0);
    const r = l.check("device:abc", { known: true }, 1000);
    expect(r.ok).toBe(false);
    expect(r.ok ? 0 : r.retryAfterS).toBe(15 * 60 - 1);
    expect(l.check("device:other", { known: true }, 1000).ok).toBe(true);
  });

  it("forgets a client after a success and prunes stale entries", () => {
    const l = loginLimiter({ perClient: 2 });
    l.fail("a", 0);
    l.fail("a", 0);
    l.succeed("a");
    expect(l.blocked("a", 0)).toBe(false);
    for (let i = 0; i < 20; i++) l.fail(`ip${i}`, 0);
    expect(l.size()).toBe(20);
    l.blocked("x", 16 * 60_000);
    expect(l.size()).toBe(0);
  });
});
