import { expect, test } from "./hub.ts";
import { questHub, stopQuestHub } from "./quest-hub.ts";
import { lane, openRoom, taskDetails } from "./quest-room.ts";

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

  // In the Quest room, each member's lane says whose Task changed the same file.
  await openRoom(page, "Make the shop badge");
  const badge = lane(page, "Quill");
  const review = lane(page, "Ada");
  await expect(review).toContainText("Same file as Quill", { timeout: 15_000 });
  await expect(badge).toContainText("Same file as Ada");
  await expect(lane(page, "Aldric")).not.toContainText("Same file");

  // Each Task's details show the finding, which names the file and the other Task.
  for (const [owner, title] of [
    ["Ada", "Review the shop"],
    ["Quill", "Make the shop badge"],
  ] as const) {
    const drawer = await taskDetails(page, title, owner);
    await expect(drawer).toContainText("Finding");
    await expect(drawer).toContainText("Ada changed web/badge.png");
    await expect(drawer).toContainText("Quill's Task");
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

  await openRoom(page, "Make the shop badge");
  // Quill and Ada wrote the badge while both were at work: each names only the other.
  const review = lane(page, "Ada");
  const badge = lane(page, "Quill");
  await expect(review).toContainText("Same file as Quill", { timeout: 15_000 });
  await expect(badge).toContainText("Same file as Ada");
  for (const row of [review, badge]) await expect(row).not.toContainText(/Same file as (\w+, )*Aldric/);
  // Aldric cleared it before either started, so nothing pairs his Task with theirs.
  await expect(lane(page, "Aldric")).not.toContainText("Same file");
});
