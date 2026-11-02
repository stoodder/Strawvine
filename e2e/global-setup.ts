/**
 * Once per run: onboard through the UI (Sunday 2026-10-25, bench press 225 — exactly what
 * `login()` does on an empty database) and ask scripts/e2e.mjs to snapshot the result as the
 * template every later reset clones. Saves the ~4 s of onboarding in every test.
 *
 * Skipped without E2E_CONTROL_URL (Playwright run by hand) and with E2E_NO_TEMPLATE.
 */
import { chromium, devices, type FullConfig } from "@playwright/test";
import { expectSynced, keepAnimationsOnTheRealTimeline, onboardedOn, serverData } from "./helpers";

export default async function globalSetup(config: FullConfig) {
  const control = process.env.E2E_CONTROL_URL;
  if (!control || process.env.E2E_NO_TEMPLATE) return;
  const started = Date.now();
  const reset = await fetch(`${control}/reset?fresh=1`, { method: "POST" });
  if (!reset.ok) throw new Error(`global setup: resetting the e2e database failed: ${reset.status} ${await reset.text()}`);

  const use = config.projects[0]!.use;
  const browser = await chromium.launch(use.launchOptions);
  try {
    const { defaultBrowserType: _, ...phone } = devices["Pixel 7"];
    const context = await browser.newContext({ ...phone, baseURL: use.baseURL, serviceWorkers: "block" });
    await keepAnimationsOnTheRealTimeline(context);
    const page = await context.newPage();
    await onboardedOn(page);
    await expectSynced(page);
    // Everything onboarding writes is on the server before the snapshot.
    const data = await serverData(page);
    if (!data.settings.onboarded || !data.maxEntries.length) throw new Error("global setup: onboarding didn't reach the server");
    await context.close();
  } finally {
    await browser.close();
  }

  const commit = await fetch(`${control}/template/commit`, { method: "POST" });
  if (!commit.ok) throw new Error(`global setup: saving the template failed: ${commit.status} ${await commit.text()}`);
  console.log(`e2e: onboarded template ready in ${((Date.now() - started) / 1000).toFixed(1)} s`);
}
