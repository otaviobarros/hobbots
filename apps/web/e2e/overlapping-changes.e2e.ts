import { expect, test } from "./hub.ts";
import { questHub, stopQuestHub } from "./quest-hub.ts";

test.afterEach(stopQuestHub);

// Issue #570: Quill makes the shop badge while Ada reviews the shop, and both change the badge's
// file while both are at work. The hub's finding shows on both Tasks.

// covers OR-004
test("[TC-OR-283] two members changing the same file show the hub's finding on both Tasks", async ({ page }) => {
  const { url, aldric } = await questHub();
  await page.goto(`${url}/#/hobs/${aldric}/new`);
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  await composer.fill("Make the shop badge in our green");
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeVisible();

  // In the Quest tab, each member's row says whose Task changed the same file.
  await page.getByRole("tab", { name: "Quest" }).click();
  const room = page.getByRole("region", { name: "Control room for Make the shop badge" });
  const tasks = room.getByRole("list", { name: "Tasks of Make the shop badge" });
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
    const drawer = page.getByRole("complementary", { name: `${title}, Task details` });
    await expect(drawer).toContainText("Finding");
    await expect(drawer).toContainText("Ada changed web/badge.png");
    await expect(drawer).toContainText("Quill's Task");
  }
});
