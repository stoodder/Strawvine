#!/usr/bin/env node
/**
 * Contrast audit (`npm run audit:contrast`; CI runs it after the e2e tests): every visible text
 * on the main screens, measured against the pixels actually painted behind it
 * (scripts/lib/contrast.mjs) — so grey text in a nested span inside a tinted parent, text on a
 * gradient or over a chart is caught, which the style lint (mute-on-tint, by class string) can't
 * see. Standard mode must reach 4.5:1 (3:1 for large text); high-contrast mode 7:1 (4.5:1 large).
 *
 *   npm run build && npm run audit:contrast              # report; exits 0
 *   npm run audit:contrast -- --strict                   # exit 1 when anything is below its ratio
 *   CONTRAST_AUDIT_APP_DIR=… npm run audit:contrast      # audit another build (<dir>/dist)
 *
 * 1. starts the production server (dist/server/index.js) on a fresh database, signs in through
 *    the API, onboards (bench 225, cycle from Monday 2026-10-26) and seeds three weeks of history
 *    (scripts/lib/seed-history.mjs — the same data the e2e accessibility specs use);
 * 2. opens each screen on Monday 2026-10-26 in Chromium (a Pixel 7), with the ambient glow hidden,
 *    in standard and in high-contrast mode, and measures every text element;
 * 3. prints what is below its ratio (screen, element, text, ratio, colours), adds it to the GitHub
 *    job summary, and writes contrast-audit.json to CONTRAST_AUDIT_OUT when set.
 *
 * CONTRAST_AUDIT_DATABASE_URL (default postgres://postgres@localhost:5432/strawvine_contrast_audit)
 * is dropped and recreated, so its name must contain "audit" and its host must be local (CI=true
 * lifts the host check). Chromium: Playwright's (`npx playwright install chromium`), or E2E_CHROMIUM.
 */
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, devices } from "@playwright/test";
import postgres from "postgres";
import { formatContrast, measureTextContrast } from "./lib/contrast.mjs";
import { seedHistory } from "./lib/seed-history.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appDir = process.env.CONTRAST_AUDIT_APP_DIR ? path.resolve(process.env.CONTRAST_AUDIT_APP_DIR) : root;
const dbUrl = process.env.CONTRAST_AUDIT_DATABASE_URL ?? "postgres://postgres@localhost:5432/strawvine_contrast_audit";
const outDir = process.env.CONTRAST_AUDIT_OUT;
const strict = process.argv.includes("--strict");
const PASSWORD = "contrast-audit-password";
const SESSION_SECRET = "contrast-audit-session-secret-0123456789abcdef0123";
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", ""]);
/** Onboarded the day before the first cycle starts; audited on its first Monday (week 1, full session). */
const ONBOARDED = "2026-10-25";
const CYCLE_START = "2026-10-26";
const AUDIT_AT = new Date(2026, 9, 26, 10, 0, 0);

/** Screens: name, path, an optional step to run once it is open, and optionally the part to measure. */
const SCREENS = [
  ["Today", "/", null],
  // The checklist is an accordion: one editor open at a time.
  ...["Weigh-in", "Nutrition", "Steps", "Metcon", "Zone 2"].map((row) => [
    `Today (${row} open)`,
    "/",
    async (page) => {
      // The row's disclosure button (not its "… complete" check dot).
      const button = page
        .locator("button[aria-controls]")
        .filter({ hasText: new RegExp(`^${row}`) })
        .first();
      if ((await button.getAttribute("aria-expanded")) !== "true") await button.click();
      await page
        .locator("button[aria-controls][aria-expanded=true]")
        .filter({ hasText: new RegExp(`^${row}`) })
        .waitFor();
    },
  ]),
  ["Train", "/train", null],
  // Sheets (only the sheet's own text: the page behind it is dimmed on purpose).
  [
    "Train (add exercise sheet)",
    "/train",
    async (page) => {
      await page.getByRole("button", { name: "Exercise", exact: true }).click();
      await page.getByRole("dialog").getByRole("textbox", { name: "Search or create exercise" }).waitFor();
    },
    "[role=dialog]",
  ],
  [
    "Train (AMRAP sheet)",
    "/train",
    async (page) => {
      await page.getByRole("button", { name: /^Bench press set \d+:.*AMRAP/ }).click();
      await page.getByRole("dialog", { name: /AMRAP/ }).waitFor();
    },
    "[role=dialog]",
  ],
  ["Progress", "/progress", null],
  ["Goals", "/goals", null],
  [
    "Goals (new strength target sheet)",
    "/goals",
    async (page) => {
      await page.getByRole("button", { name: "Add strength target" }).click();
      await page.getByRole("dialog", { name: "New strength target" }).waitFor();
    },
    "[role=dialog]",
  ],
  ["Settings", "/settings", null],
  ["Program", "/program", null],
];

function guardedDatabaseName() {
  const url = new URL(dbUrl);
  const name = decodeURIComponent(url.pathname.slice(1));
  if (!/^[\w-]+$/.test(name)) throw new Error(`Unexpected database name "${name}"`);
  if (!/audit/i.test(name)) throw new Error(`Refusing to use "${name}": the database name must contain "audit".`);
  const ci = process.env.CI === "true" || process.env.CI === "1";
  if (!ci && !LOCAL_HOSTS.has(url.hostname.toLowerCase()))
    throw new Error(`Refusing to use a database on "${url.hostname}": it must be local (or CI=true).`);
  return name;
}

async function recreateDatabase() {
  const name = guardedDatabaseName();
  const admin = new URL(dbUrl);
  admin.pathname = "/postgres";
  const sql = postgres(admin.toString(), { max: 1, onnotice: () => {} });
  try {
    await sql.unsafe(`drop database if exists "${name}" with (force)`);
    await sql.unsafe(`create database "${name}"`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function startServer() {
  const port = await freePort();
  const server = spawn(process.execPath, ["dist/server/index.js"], {
    cwd: appDir,
    stdio: ["ignore", "ignore", "inherit"],
    env: { ...process.env, NODE_ENV: "test", DATABASE_URL: dbUrl, APP_PASSWORD: PASSWORD, SESSION_SECRET, PORT: String(port) },
  });
  const base = `http://localhost:${port}`;
  const until = Date.now() + 30_000;
  for (;;) {
    if (server.exitCode !== null) throw new Error(`server exited early (${server.exitCode})`);
    if (
      await fetch(`${base}/api/health`).then(
        (r) => r.ok,
        () => false,
      )
    )
      break;
    if (Date.now() > until) throw new Error("server not healthy after 30 s");
    await new Promise((r) => setTimeout(r, 100));
  }
  return {
    base,
    stop: () => new Promise((resolve) => (server.exitCode !== null ? resolve() : (server.once("exit", resolve), server.kill("SIGTERM")))),
  };
}

/** A tiny API client with a cookie jar, signed in. */
async function client(base) {
  const jar = new Map();
  const call = async (method, url, body) => {
    const res = await fetch(base + url, {
      method,
      headers: {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; "),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(";");
      const i = pair.indexOf("=");
      jar.set(pair.slice(0, i), pair.slice(i + 1));
    }
    if (!res.ok) throw new Error(`${method} ${url} → ${res.status} ${await res.text()}`);
    return res.status === 204 ? null : res.json();
  };
  await call("POST", "/api/auth/login", { password: PASSWORD });
  return call;
}

/** What onboarding writes (screens/Onboarding.tsx): the bench max, then onboarded settings. */
async function onboard(call) {
  const boot = await call("GET", "/api/bootstrap");
  const bench = boot.exercises.find((e) => e.name === "Bench press");
  await call("POST", `/api/exercises/${bench.id}/maxes`, { date: ONBOARDED, valueLb: 225, source: "initial", note: null });
  await call("PUT", "/api/settings", {
    ...boot.settings,
    onboarded: true,
    program: { ...boot.settings.program, cycleStartDate: CYCLE_START },
  });
}

async function setHighContrast(call, on) {
  const { settings } = await call("GET", "/api/bootstrap");
  await call("PUT", "/api/settings", { ...settings, display: { ...(settings.display ?? {}), highContrast: on } });
}

/** Press "Continue" on celebration overlays until none is left. */
async function dismissOverlays(page) {
  for (let i = 0; i < 10; i++) {
    const cont = page
      .getByRole("dialog")
      .getByRole("button", { name: /^Continue/ })
      .last();
    if (!(await cont.isVisible().catch(() => false))) return;
    await page.waitForTimeout(500);
    await cont.click({ timeout: 2000 }).catch(() => {});
    await page.waitForTimeout(400);
  }
}

/**
 * The measurement checks itself first, on fixtures with known ratios: #767676 on white is 4.54:1,
 * #777 on white 4.48:1, grey in a nested span on a tinted panel, and text across a gradient (its
 * dark half decides).
 */
async function selfTest(browser) {
  const page = await browser.newPage();
  try {
    await page.setContent(`<body style="margin:0;background:#fff;font:16px sans-serif">
      <p id="a" style="color:#767676">Passes at 4.54</p>
      <p id="b" style="color:#777">Fails at 4.48</p>
      <div style="background:#0a0b0d;padding:8px"><div style="background:rgb(255 255 255 / 0.08);padding:8px">
        <span style="color:#b4b9c2">Kcal <span id="c" style="color:#6b717c">g</span></span></div></div>
      <p id="d" style="color:#fff;background:linear-gradient(90deg,#000,#fff);width:300px">Across a gradient to white</p>
    </body>`);
    const r = Object.fromEntries(
      (await measureTextContrast(page, { targets: ["#a", "#b", "#c", "#d"] })).map((m, i) => ["abcd"[i], m.ratio]),
    );
    const near = (v, x) => v !== null && Math.abs(v - x) < 0.06;
    // #6b717c over white/8% on ink-950 (≈ rgb(30,31,33)): ≈3.4:1
    if (!near(r.a, 4.54) || !near(r.b, 4.48) || !(r.c > 2.8 && r.c < 4) || !(r.d < 4.5))
      throw new Error(`self-test failed: measured ${JSON.stringify(r)} (expected a≈4.54, b≈4.48, c≈3.4, d<4.5)`);
  } finally {
    await page.close();
  }
}

async function audit(base, call) {
  const browser = await chromium.launch(process.env.E2E_CHROMIUM ? { executablePath: process.env.E2E_CHROMIUM } : {});
  const findings = [];
  let measuredCount = 0;
  try {
    await selfTest(browser);
    const { defaultBrowserType: _, ...phone } = devices["Pixel 7"];
    const context = await browser.newContext({ ...phone, baseURL: base, serviceWorkers: "block" });
    const page = await context.newPage();
    // Only Date is shifted to the audit day. (Playwright's clock also fakes performance.now(), and
    // Motion's WAAPI fades then start seconds "in the future": text stays at opacity 0.)
    await page.addInitScript((target) => {
      const offset = target - Date.now();
      const RealDate = Date;
      class ShiftedDate extends RealDate {
        constructor(...args) {
          super(...(args.length ? args : [RealDate.now() + offset]));
        }
        static now() {
          return RealDate.now() + offset;
        }
      }
      globalThis.Date = ShiftedDate;
    }, AUDIT_AT.getTime());
    await page.goto("/");
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.getByRole("navigation", { name: "Primary" }).waitFor();

    for (const highContrast of [false, true]) {
      await setHighContrast(call, highContrast);
      const mode = highContrast ? "high contrast" : "standard";
      for (const [name, url, step, within] of SCREENS) {
        await page.goto(url);
        await page.getByRole("heading", { level: 1 }).first().waitFor();
        if (highContrast) await page.locator('html[data-contrast="high"]').waitFor({ state: "attached" });
        await dismissOverlays(page);
        if (step) await step(page);
        await page.waitForTimeout(800); // entrance animations
        await dismissOverlays(page);
        // …and whatever is still fading in (an opened editor): finish it.
        await page.evaluate(() => {
          for (const a of document.getAnimations()) if (Number.isFinite(a.effect?.getComputedTiming().endTime)) a.finish();
        });
        await page.waitForTimeout(200);
        // The ambient glow: a 7 % tint at the very top, not a surface text is meant to sit on.
        await page.evaluate(() => {
          const sheet = new CSSStyleSheet();
          sheet.replaceSync("body::before { display: none !important; }");
          document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
        });
        if (outDir)
          await page
            .screenshot({
              path: path.join(outDir, `${name.replace(/\W+/g, "-")}-${highContrast ? "hc" : "std"}.png`.toLowerCase()),
              fullPage: true,
            })
            .catch(() => {});
        const results = await measureTextContrast(page, { highContrast, within });
        measuredCount += results.length;
        const failing = results.filter((r) => r.ratio === null || r.ratio < r.required);
        console.log(
          `contrast-audit: ${name} (${mode}): ${results.length} texts, ${failing.length} below ${highContrast ? "7:1" : "4.5:1"}`,
        );
        for (const r of failing) findings.push({ screen: name, mode, ...r });
      }
    }
    await context.close();
  } finally {
    await browser.close();
  }
  return { findings, measuredCount };
}

async function main() {
  guardedDatabaseName();
  if (outDir) mkdirSync(outDir, { recursive: true });
  await recreateDatabase();
  const server = await startServer();
  let result;
  try {
    const call = await client(server.base);
    await onboard(call);
    await seedHistory(call, { through: ONBOARDED, weeks: 3 });
    result = await audit(server.base, call);
  } finally {
    await server.stop();
  }
  const { findings, measuredCount } = result;
  if (measuredCount === 0) throw new Error("nothing was measured — did the screens render?");

  const lines = findings.map((f) => `[${f.mode}] ${f.screen}: ${formatContrast(f)}`);
  if (lines.length) console.log(`\ncontrast-audit: ${lines.length} text(s) below their ratio\n  ${lines.join("\n  ")}`);
  else console.log(`\ncontrast-audit: ok — ${measuredCount} texts measured, all at or above their ratio.`);

  if (outDir) {
    writeFileSync(path.join(outDir, "contrast-audit.json"), JSON.stringify({ measured: measuredCount, findings }, null, 2));
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    const md = [
      "### Contrast audit",
      "",
      lines.length
        ? `${lines.length} text(s) below 4.5:1 (standard) / 7:1 (high contrast), measured on the rendered screens:\n\n${lines.map((l) => `- \`${l.replace(/`/g, "'")}\``).join("\n")}`
        : `${measuredCount} texts measured; all at or above their ratio.`,
      "",
    ];
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, md.join("\n"));
    if (lines.length)
      console.log(`::warning title=Contrast audit::${lines.length} text(s) below their contrast ratio (see the job summary)`);
  }
  if (strict && findings.length) process.exit(1);
}

main().catch((err) => {
  console.error(`contrast-audit: ${err instanceof Error ? err.message : err}`);
  process.exit(2);
});
