import { describe, expect, it } from "vitest";
import { deriveSessionKey, loginLimiter, makeToken, readToken } from "./auth";

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

describe("login limiter", () => {
  it("counts only failures, per client", () => {
    const l = loginLimiter({ perClient: 3, global: 100 });
    for (let i = 0; i < 3; i++) l.fail("a", 1000);
    expect(l.blocked("a", 1000)).toBe(true);
    expect(l.blocked("b", 1000)).toBe(false);
    expect(l.blocked("a", 1000 + 15 * 60_000)).toBe(false);
  });

  it("caps failures across all clients", () => {
    const l = loginLimiter({ perClient: 10, global: 5, globalWindowMs: 60 * 60_000 });
    for (let i = 0; i < 5; i++) l.fail(`10.0.0.${i}`, 1000);
    expect(l.blocked("10.0.0.99", 2000)).toBe(true);
    expect(l.blocked("10.0.0.99", 1000 + 60 * 60_000)).toBe(false);
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
