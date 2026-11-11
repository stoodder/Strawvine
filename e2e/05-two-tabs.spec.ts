/**
 * Two tabs of the app open on one device, each editing a different field of the same day: both
 * edits must reach the server (neither tab's sync may overwrite or drop the other's).
 */
import { dismissCelebrations, expect, expectSynced, fillNumber, login, test } from "./helpers";

test("edits made in two tabs both reach the server", async ({ page, context }) => {
  await dismissCelebrations(page);
  await login(page);
  const nav = page.getByRole("navigation", { name: "Primary" });
  await expect(nav).toBeVisible();

  const second = await context.newPage();
  await dismissCelebrations(second);
  await second.goto("/");
  await expect(second.getByRole("navigation", { name: "Primary" })).toBeVisible();

  await page.getByRole("button", { name: /Nutrition/ }).click();
  await fillNumber(page, "Calories", "2345");
  await second.getByRole("button", { name: /Nutrition/ }).click();
  await fillNumber(second, "Protein", "187");

  for (const tab of [page, second]) await expectSynced(tab);

  // The server has both: a fresh context (no device copy) sees them.
  const fresh = await context.browser()!.newContext({ baseURL: page.url(), storageState: await context.storageState() });
  try {
    const other = await fresh.newPage();
    await dismissCelebrations(other);
    await other.goto("/");
    await other.getByRole("button", { name: /Nutrition/ }).click();
    await expect(other.getByRole("textbox", { name: "Calories" })).toHaveValue(/2,?345/);
    await expect(other.getByRole("textbox", { name: "Protein" })).toHaveValue(/187/);
  } finally {
    await fresh.close();
  }
});
