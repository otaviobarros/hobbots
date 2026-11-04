import { expect, test } from "./hub.ts";
import { aldricHub, stopAldricHub } from "./workbench-hub.ts";

// Issue #507: the hob's tile and name in the chat header open its page.

test.afterEach(stopAldricHub);

// covers UX-001
test("[TC-CH-260] the hob's tile and name in the chat header each open its page", async ({ page }) => {
  const { url, aldric } = await aldricHub();
  const header = page.getByRole("main", { name: "Chat" }).locator("header").first();
  const hero = page.getByRole("region", { name: "Aldric", exact: true });

  await page.goto(`${url}/#/hobs/${aldric}/new`);
  await header.getByRole("link", { name: "Aldric", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`#/hobs/${aldric}$`));
  await expect(hero.getByRole("heading", { name: "Aldric" })).toBeVisible();

  await page.goto(`${url}/#/hobs/${aldric}/new`);
  await header.locator(`a[href$="/hobs/${aldric}"][aria-hidden]`).click();
  await expect(page).toHaveURL(new RegExp(`#/hobs/${aldric}$`));
  await expect(hero.getByRole("heading", { name: "Aldric" })).toBeVisible();
});

// covers UX-001
test("[TC-CH-281] the back arrow in the chat header returns to the hob's chats", async ({ page }) => {
  const { url, aldric } = await aldricHub();
  const header = page.getByRole("main", { name: "Chat" }).locator("header").first();

  await page.goto(`${url}/#/hobs/${aldric}/new`);
  await header.getByRole("link", { name: "Back to Aldric's chats" }).click();
  await expect(page).toHaveURL(new RegExp(`#/hobs/${aldric}$`));
  await expect(page.getByRole("tab", { name: /^Chats/ })).toHaveAttribute("aria-selected", "true");
  // The underlined tabs never scroll, so no scrollbar shows beside them.
  const list = page.getByRole("tablist").first();
  expect(await list.evaluate((node) => node.scrollHeight - node.clientHeight)).toBe(0);
});
