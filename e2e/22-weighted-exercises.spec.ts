/**
 * Weighted is its own choice, next to the measure: a weighted dead hang (time + load) shows and
 * logs a load; an unweighted plank (time only) has no load anywhere. The flag can be changed
 * later in the Edit exercise sheet (Program → Exercise library).
 */
import { expect, expectSynced, MONDAY, onboardedOn, openExerciseEditor, serverData, test, toastMessage } from "./helpers";

test.beforeEach(async ({ page }) => {
  await onboardedOn(page, MONDAY);
  await page.getByRole("link", { name: "Train" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/Push/);
});

async function create(page: import("@playwright/test").Page, name: string, measure: string, weighted: boolean) {
  await page.getByRole("button", { name: "Exercise", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Add exercise" });
  await sheet.getByRole("textbox", { name: "Search or create exercise" }).fill(name);
  await sheet.getByRole("button", { name: measure, exact: true }).click();
  // A hold starts unweighted; the load is a chip pair like the category and measure.
  const load = sheet.getByRole("group", { name: "Load" });
  await expect(load.getByRole("button", { name: "Unweighted" })).toHaveAttribute("aria-pressed", "true");
  const choice = load.getByRole("button", { name: weighted ? "Weighted" : "Unweighted", exact: true });
  await choice.click();
  await expect(choice).toHaveAttribute("aria-pressed", "true");
  await sheet.getByRole("button", { name: /Create & add/ }).click();
  await expect(sheet).toHaveCount(0);
}

test("a weighted hold logs a load; an unweighted one has none", async ({ page }) => {
  await create(page, "Weighted dead hang", "Time", true);
  // No load yet: the chip says so, so there's something to set.
  const first = page.getByRole("button", { name: /^Weighted dead hang set 1: 30\s?s\s*\(no load\)$/ });
  await expect(first).toBeVisible();
  // …and so does the set list in the exercise's actions.
  await page.getByRole("button", { name: "Weighted dead hang options" }).click();
  await expect(page.getByRole("button", { name: "Edit set 1: 30 seconds (no load)" })).toBeVisible();
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: /^Edit Weighted dead hang set 1:/ }).click(); // the row's values open the editor
  const editor = page.getByRole("dialog", { name: "Weighted dead hang · set 1" });
  await expect(editor.getByText("Load · lb")).toBeVisible();
  for (let i = 0; i < 5; i++) await editor.getByRole("button", { name: "Increase load" }).click();
  await editor.getByRole("button", { name: "Log set" }).click();
  await expect(page.getByRole("button", { name: /^Weighted dead hang set 1: 30\s?s\s+at\s+25\s+lb$/ })).toBeVisible();
  // The load carries to the open sets.
  await expect(page.getByRole("button", { name: /^Weighted dead hang set 2: 30\s?s\s+at\s+25\s+lb$/ })).toBeVisible();

  await create(page, "Plank", "Time", false);
  const plank = page.getByRole("button", { name: /^Plank set 1: 30\s?s$/ });
  await expect(plank).toBeVisible();
  await page.getByRole("button", { name: /^Edit Plank set 1:/ }).click();
  const plankEditor = page.getByRole("dialog", { name: "Plank · set 1" });
  await expect(plankEditor.getByText("Seconds", { exact: true })).toBeVisible();
  await expect(plankEditor.getByRole("button", { name: "Increase load" })).toHaveCount(0);
  await page.keyboard.press("Escape");

  await expectSynced(page);
  const { exercises } = await serverData(page);
  expect(exercises.find((e) => e.name === "Weighted dead hang")).toMatchObject({ measure: "seconds", weighted: true });
  expect(exercises.find((e) => e.name === "Plank")).toMatchObject({ measure: "seconds", weighted: false });

  // Made weighted later in the library: the plank's sets now offer a load.
  const setLoad = async (choice: "Weighted" | "Unweighted") => {
    const sheet = await openExerciseEditor(page, "Plank");
    const load = sheet.getByRole("group", { name: "Load" });
    const other = choice === "Weighted" ? "Unweighted" : "Weighted";
    await expect(load.getByRole("button", { name: other, exact: true })).toHaveAttribute("aria-pressed", "true");
    await load.getByRole("button", { name: choice, exact: true }).click();
    await sheet.getByRole("button", { name: "Save" }).click();
    await expect(sheet).toHaveCount(0);
  };
  await setLoad("Weighted");
  await expect(page.getByRole("button", { name: "Edit Plank" })).toHaveAccessibleDescription("Accessory · time · weighted");
  // A main lift always carries a load: no choice to turn it off.
  const bench = await openExerciseEditor(page, "Bench press");
  await expect(bench.getByRole("group", { name: "Load" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expectSynced(page);
  expect((await serverData(page)).exercises.find((e) => e.name === "Plank")).toMatchObject({ weighted: true });

  // Back off: the logged loads are kept, and Undo turns it back on.
  await setLoad("Unweighted");
  await expect(toastMessage(page, "Plank no longer tracks load — logged loads are kept")).toBeVisible();
  await expect(page.getByRole("button", { name: "Edit Plank" })).toHaveAccessibleDescription("Accessory · time");
  await expectSynced(page);
  expect((await serverData(page)).exercises.find((e) => e.name === "Plank")).toMatchObject({ weighted: false });
  await page.getByRole("region", { name: "Notifications" }).getByRole("button", { name: "Undo" }).click();
  await expect(page.getByRole("button", { name: "Edit Plank" })).toHaveAccessibleDescription("Accessory · time · weighted");
  await expectSynced(page);
  expect((await serverData(page)).exercises.find((e) => e.name === "Plank")).toMatchObject({ weighted: true });

  await page.goto("/train");
  await expect(page.getByRole("button", { name: /^Plank set 1: 30\s?s\s*\(no load\)$/ })).toBeVisible();
});
