import { expect, test } from "./hub.ts";
import { questHub, stopQuestHub } from "./quest-hub.ts";

test.afterEach(stopQuestHub);

// covers IN-004, OR-006, UX-006
test("[TC-IN-544] a member's failed Task waits in the Inbox and on the lead's tile, and Retry there takes it out", async ({
  page,
}) => {
  const { url, aldric } = await questHub();
  await page.goto(`${url}/#/hobs/${aldric}/new`);
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
  await detail.getByRole("button", { name: "Retry" }).click();
  await expect(detail.getByRole("status")).toHaveText("Sent back to Quill for another try.");
  await expect(banner).toBeHidden({ timeout: 15_000 });
  await expect(page.getByRole("banner").getByText("1 waiting on you")).toBeVisible();

  // The other opens over Aldric's chat, where it can go to another hob.
  await list.getByRole("link", { name: /Schedule the sale email/ }).click();
  const email = page.getByRole("article", { name: "Failed task from Ada: Schedule the sale email" });
  await expect(email.getByRole("button", { name: "Retry" })).toBeEnabled();
  await email.getByRole("link", { name: "Open the task" }).click();
  await expect(page).toHaveURL(new RegExp(`/hobs/${aldric}/threads/[^?]+\\?task=`));
  await expect(page.getByRole("dialog", { name: "Schedule the sale email, task details" })).toBeVisible();
});
