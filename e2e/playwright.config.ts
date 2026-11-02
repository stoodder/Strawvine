/**
 * Playwright config for the e2e suite. Run it through `npm run e2e` (scripts/e2e.mjs), which
 * builds, starts the server, resets the database before each test and sets E2E_BASE_URL /
 * E2E_PASSWORD / E2E_CONTROL_URL.
 *
 * Browsers: CI runs `npx playwright install --with-deps chromium`; locally a preinstalled set is
 * used through PLAYWRIGHT_BROWSERS_PATH, or point E2E_CHROMIUM at a Chromium binary.
 */
import { defineConfig, devices } from "@playwright/test";

const executablePath = process.env.E2E_CHROMIUM || undefined;

export default defineConfig({
  testDir: ".",
  // Onboards once and saves the result as the template every test's database is cloned from.
  globalSetup: "./global-setup.ts",
  // One server and one database: tests run one at a time. Each starts from a copy of the
  // onboarded template, or an empty database when it asks for one (the `test` fixture in
  // helpers.ts resets it), so they're independent and a retry starts clean.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [
    ...(process.env.CI ? ([["github"], ["list"], ["html", { open: "never", outputFolder: ".report" }]] as const) : ([["list"]] as const)),
    // scripts/e2e.mjs reads this to print its summary table.
    ...(process.env.E2E_SUMMARY_FILE ? ([["json", { outputFile: process.env.E2E_SUMMARY_FILE }]] as const) : []),
  ],
  outputDir: ".results",
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3114",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    // A phone: the app is mobile-first.
    ...devices["Pixel 7"],
    launchOptions: executablePath ? { executablePath } : {},
    // The service worker would serve cached shells between tests; the offline spec opts back in.
    serviceWorkers: "block",
  },
  projects: [{ name: "mobile-chromium" }],
});
