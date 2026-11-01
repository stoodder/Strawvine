import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, looksRandomEnough, readBuildId, secretProblems, trustProxyFrom } from "./config";

const HEX = "3f9a0c4be1d27786a5f0e93c1b6d4a2e8c7b5f1d0e9a3c6b2f4d8e1a7c5b9d0f";
const B64 = "Bg+0HbA63qDN/rlcbxi/NDBcBmJtYtyTzyMh0yUbuVE=";
const prod = (sessionSecret: string, password = "a good long passphrase") => secretProblems({ production: true, sessionSecret, password });

describe("secret checks", () => {
  it("accepts real random secrets in production", () => {
    expect(prod(HEX)).toEqual([]);
    expect(prod(B64)).toEqual([]);
    expect(looksRandomEnough(HEX.toUpperCase())).toBe(true);
  });

  it("refuses placeholders and weak secrets in production", () => {
    expect(prod("replace-with-a-long-random-string")[0]).toMatch(/placeholder/);
    expect(prod("local-dev-secret-local-dev-secret-0000")[0]).toMatch(/placeholder/);
    expect(prod("x".repeat(64))[0]).toMatch(/256 random bits/);
    expect(prod("this is my super long session secret phrase!!")[0]).toMatch(/256 random bits/);
    expect(prod(HEX.slice(0, 40))[0]).toMatch(/256 random bits/);
  });

  it("refuses default or short passwords in production", () => {
    expect(prod(HEX, "change-me")[0]).toMatch(/placeholder/);
    expect(prod(HEX, "Strawvine")[0]).toMatch(/placeholder/);
    expect(prod(HEX, "short-pass")[0]).toMatch(/at least 12/);
    expect(prod(HEX, "   short-pass   ")[0]).toMatch(/at least 12/);
    expect(prod(HEX, " ".repeat(20))[0]).toMatch(/at least 12/);
    expect(prod(HEX, "aaaaaaaaaaaaaaaa")[0]).toMatch(/too repetitive/);
    expect(prod(HEX, "abcabcabcabcABC")[0]).toMatch(/too repetitive/);
    expect(prod(HEX, "abcdefabcdef")).toEqual([]);
    expect(prod(HEX, HEX)).toContain("APP_PASSWORD and SESSION_SECRET must differ.");
  });

  it("stays permissive outside production", () => {
    expect(secretProblems({ production: false, sessionSecret: "replace-with-a-long-random-string", password: "change-me" })).toEqual([]);
    expect(secretProblems({ production: false, sessionSecret: "short", password: "x" })[0]).toMatch(/32 characters/);
  });

  it("refuses to load a production config with every problem listed", () => {
    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        DATABASE_URL: "postgres://x",
        APP_PASSWORD: "strawvine",
        SESSION_SECRET: "local-dev-secret-local-dev-secret-0000",
      }),
    ).toThrow(/Refusing to start:[\s\S]*SESSION_SECRET[\s\S]*APP_PASSWORD/);
    expect(() => loadConfig({ NODE_ENV: "production" })).toThrow(/DATABASE_URL[\s\S]*APP_PASSWORD[\s\S]*SESSION_SECRET/);
    const ok = loadConfig({
      NODE_ENV: "production",
      DATABASE_URL: "postgres://x",
      APP_PASSWORD: "a good long passphrase",
      SESSION_SECRET: HEX,
      DYNO: "web.1",
      PORT: "5000",
    });
    expect(ok).toMatchObject({ production: true, trustProxy: true, port: 5000 });
  });
});

describe("environment helpers", () => {
  it("trusts the proxy on Heroku unless told otherwise", () => {
    expect(trustProxyFrom({})).toBe(false);
    expect(trustProxyFrom({ DYNO: "web.1" })).toBe(true);
    expect(trustProxyFrom({ DYNO: "web.1", TRUST_PROXY: "0" })).toBe(false);
    expect(trustProxyFrom({ TRUST_PROXY: "1" })).toBe(true);
  });

  it("reads the build id only from dist/build-id.txt (what the client was compiled with)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "strawvine-dist-"));
    try {
      expect(readBuildId(dir)).toBeUndefined();
      writeFileSync(path.join(dir, "build-id.txt"), "1793561420\n");
      expect(readBuildId(dir)).toBe("1793561420");
      writeFileSync(path.join(dir, "build-id.txt"), "bad id\r\nx: y");
      expect(readBuildId(dir)).toBeUndefined();
      // A runtime BUILD_ID is ignored.
      const env = { DATABASE_URL: "postgres://x", APP_PASSWORD: "pw", SESSION_SECRET: "s".repeat(40), BUILD_ID: "runtime" };
      expect(loadConfig(env).buildId).not.toBe("runtime");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
