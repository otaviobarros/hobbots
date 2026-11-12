import { expect, test } from "./hub.ts";
import { questHub, stopQuestHub } from "./quest-hub.ts";
import { openQuest, showInWorkbench, taskDetails } from "./quest-sheet.ts";

test.afterEach(stopQuestHub);

// Issue #582: Aldric keeps Quill to the shop's web folder and lets Ada review the whole shop. Each
// Task's drawer lists the folders its member works in, and the Workbench header names them.

// covers PE-002
test("[TC-PE-303] the Task drawer and the Workbench header show the folders each member works in", async ({ page }) => {
  const { url, aldric } = await questHub();
  await page.goto(`${url}/#/hobs/${aldric}/chat`);
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  await composer.fill("Make the shop badge in our green");
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeVisible();

  await openQuest(page, "Make the shop badge");
  for (const [owner, title, folder] of [
    ["Quill", "Make the shop badge", "/fake/shop/web"],
    ["Ada", "Review the shop", "/fake/shop"],
  ] as const) {
    const drawer = await taskDetails(page, title, owner);
    await expect(drawer.getByRole("list", { name: "Folders" }).getByRole("listitem")).toHaveText([folder]);
  }
  const header = (await showInWorkbench(page, "Make the shop badge", "Quill")).locator("header").first();
  await expect(header).toContainText("Works in web");
  await expect(header.getByText("Works in web")).toHaveAttribute("title", "/fake/shop/web");
});
