import { expect, test } from "./hub.ts";
import { questHub, stopQuestHub } from "./quest-hub.ts";
import { laneTask } from "./quest-sheet.ts";

test.afterEach(stopQuestHub);

// covers IN-004, OR-006, UX-006
test("[TC-IN-544] a member's failed Task waits in the Inbox and on the lead's tile, and Retry there takes it out", async ({
  page,
}) => {
  const { url, aldric } = await questHub();
  await page.goto(`${url}/#/hobs/${aldric}/chat`);
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  await composer.fill("Plan a spring sale for the shop");
  await composer.press("Enter");
  // Two members' Tasks fail while the rest of the Quest goes on: each waits on you, under Aldric.
  const inbox = page.getByRole("navigation", { name: "Sections" }).getByRole("link", { name: /^Inbox, / });
  await expect(inbox).toHaveAccessibleName(/2 waiting on you/, { timeout: 15_000 });
  const tile = page.getByRole("navigation", { name: "Sections" }).getByRole("button", { name: /^Aldric, / });
  await expect(tile).toHaveAccessibleName(/needs you/i);

  await inbox.click();
  const list = page.getByRole("list", { name: "Requests" });
  const banner = list.getByRole("link", { name: /Write the sale banner/ });
  await expect(banner).toContainText("Quill's task failed");
  await expect(list.getByRole("link", { name: /Schedule the sale email/ })).toContainText("Ada's task failed");

  await banner.click();
  const detail = page.getByRole("article", { name: "Failed task from Quill: Write the sale banner" });
  await expect(detail.getByRole("heading", { name: "Quill's task failed" })).toBeVisible();
  await expect(detail).toContainText("The rest of Aldric's quest goes on without it.");
  // The hub's answer to Retry is held until its event has taken the Task out of Needs you, so the
  // event lands first. The toast still says it went back, and focus moves to the entry that takes
  // its place rather than to the page (#988).
  const retried = /\/api\/tasks\/[^/]+\/retry$/;
  const held: Array<() => Promise<void>> = [];
  await page.route(retried, async (route) => {
    // The hub records the retry and sends its event; only its answer waits.
    const response = await route.fetch();
    held.push(() => route.fulfill({ response }));
  });
  await detail.getByRole("button", { name: "Retry" }).focus();
  await page.keyboard.press("Enter");
  await expect(banner).toBeHidden({ timeout: 15_000 });
  await expect(detail).toBeHidden();
  await expect(page.getByRole("banner").getByText("1 waiting on you")).toBeVisible();
  const next = list.getByRole("link", { name: /Schedule the sale email/ });
  await expect(next).toBeFocused();
  await expect.poll(() => held.length).toBe(1);
  for (const answer of held.splice(0)) await answer();
  await page.unroute(retried);
  await expect(
    page.getByRole("region", { name: /^Notifications/ }).getByText("Sent back to Quill for another try."),
  ).toBeVisible();
  await expect(next).toBeFocused();

  // The other opens in the Quest room beside Aldric's chat, where it can go to another hob.
  await list.getByRole("link", { name: /Schedule the sale email/ }).click();
  const email = page.getByRole("article", { name: "Failed task from Ada: Schedule the sale email" });
  await expect(email.getByRole("button", { name: "Retry" })).toBeEnabled();
  await email.getByRole("link", { name: "Open the task" }).click();
  await expect(page).toHaveURL(new RegExp(`/hobs/${aldric}/threads/[^?]+\\?quest=`));
  await expect(laneTask(page, "Schedule the sale email", "Ada")).toContainText("Failed");
});
