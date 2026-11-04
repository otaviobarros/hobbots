import { expect, test } from "./hub.ts";
import { questHub, stopQuestHub } from "./quest-hub.ts";
import { openQuest, taskSheet } from "./work-sheet.ts";

test.afterEach(stopQuestHub);

// Issue #570: Quill makes the shop badge while Ada reviews the shop, and both change the badge's
// file while both are at work. The hub's finding shows on both Tasks. Issue #658: Aldric cleared
// the badge before he delegated, and his long-running Attempt keeps that change; it is no finding.

// covers OR-004
test("[TC-OR-283] two members changing the same file show the hub's finding on both Tasks", async ({ page }) => {
  const { url, aldric } = await questHub();
  await page.goto(`${url}/#/hobs/${aldric}/new`);
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  await composer.fill("Make the shop badge in our green");
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeVisible();

  // On the quest sheet, each member's row says whose Task changed the same file.
  const tasks = await openQuest(page, "Make the shop badge");
  const badge = tasks.getByRole("button", { name: /Quill · Make the shop badge/ });
  const review = tasks.getByRole("button", { name: /Ada · Review the shop/ });
  await expect(review).toContainText("Same file as Quill", { timeout: 15_000 });
  await expect(badge).toContainText("Same file as Ada");
  await expect(tasks.getByRole("button", { name: /Aldric · Make the shop badge/ })).not.toContainText("Same file");

  // Each Task's drawer shows the finding, which names the file and the other Task.
  for (const [row, title] of [
    [review, "Review the shop"],
    [badge, "Make the shop badge"],
  ] as const) {
    await row.click();
    const drawer = taskSheet(page, title);
    await expect(drawer).toContainText("Finding");
    await expect(drawer).toContainText("Ada changed web/badge.png");
    await expect(drawer).toContainText("Quill's Task");
    await drawer.getByRole("button", { name: "Back to Make the shop badge" }).click();
  }
});

// covers OR-004
test("[TC-OR-411] the lead's change from before it delegated shows no Same file label", async ({ page }) => {
  const { url, aldric } = await questHub();
  await page.goto(`${url}/#/hobs/${aldric}/new`);
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  await composer.fill("Make the shop badge in our green");
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeVisible();

  const tasks = await openQuest(page, "Make the shop badge");
  // Quill and Ada wrote the badge while both were at work: each names only the other.
  const review = tasks.getByRole("button", { name: /Ada · Review the shop/ });
  const badge = tasks.getByRole("button", { name: /Quill · Make the shop badge/ });
  await expect(review).toContainText("Same file as Quill", { timeout: 15_000 });
  await expect(badge).toContainText("Same file as Ada");
  for (const row of [review, badge]) await expect(row).not.toContainText(/Same file as (\w+, )*Aldric/);
  // Aldric cleared it before either started, so nothing pairs his Task with theirs.
  await expect(tasks.getByRole("button", { name: /Aldric · Make the shop badge/ })).not.toContainText("Same file");
});
