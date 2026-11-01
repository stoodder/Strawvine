/**
 * Playwright config for the e2e suite. Run it through `npm run e2e` (scripts/e2e.mjs), which
 * builds, starts the server on a fresh database and sets E2E_BASE_URL / E2E_PASSWORD.
 *
 * Browsers: CI runs `npx playwright install --with-deps chromium`; locally a preinstalled set is
 * used through PLAYWRIGHT_BROWSERS_PATH, or point E2E_CHROMIUM at a Chromium binary.
 */
import { defineConfig, devices } from "@playwright/test";

const executablePath = process.env.E2E_CHROMIUM || undefined;

export default defineConfig({
  testDir: ".",
  // The specs share one database and build on each other (01 onboards, later ones train/log).
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [["github"], ["list"], ["html", { open: "never", outputFolder: ".report" }]] : "list",
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
