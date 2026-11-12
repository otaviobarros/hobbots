import { expect, test } from "./hub.ts";
import { aldricHub, stopAldricHub } from "./workbench-hub.ts";

// Issue #507: the hob's tile and name in the chat header open its page. In the hob's chat the name
// reads "Your chat with" it (#1378).

test.afterEach(stopAldricHub);

// covers UX-001
test("[TC-CH-260] the hob's tile and name in the chat header each open its page", async ({ page }) => {
  const { url, aldric } = await aldricHub();
  const header = page.getByRole("main", { name: "Chat" }).locator("header").first();
  const hero = page.getByRole("region", { name: "Aldric", exact: true });

  await page.goto(`${url}/#/hobs/${aldric}/chat`);
  await header.getByRole("link", { name: "Your chat with Aldric", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`#/hobs/${aldric}$`));
  await expect(hero.getByRole("heading", { name: "Aldric" })).toBeVisible();

  await page.goto(`${url}/#/hobs/${aldric}/chat`);
  await header.locator(`a[href$="/hobs/${aldric}"][aria-hidden]`).click();
  await expect(page).toHaveURL(new RegExp(`#/hobs/${aldric}$`));
  await expect(hero.getByRole("heading", { name: "Aldric" })).toBeVisible();
});

// covers UX-001
test("[TC-CH-281] the back arrow in the chat header returns to the hob's chats", async ({ page }) => {
  const { url, aldric } = await aldricHub();
  const header = page.getByRole("main", { name: "Chat" }).locator("header").first();

  await page.goto(`${url}/#/hobs/${aldric}/chat`);
  await header.getByRole("link", { name: "Back to Aldric's chats" }).click();
  await expect(page).toHaveURL(new RegExp(`#/hobs/${aldric}$`));
  await expect(page.getByRole("tab", { name: /^Chats/ })).toHaveAttribute("aria-selected", "true");
  // The underlined tabs are no scroll container, so the selected tab's bar, which hangs over the line
  // under them, cannot show a scrollbar beside them.
  const list = page.getByRole("tablist").first();
  expect(await list.evaluate((node) => getComputedStyle(node).overflowY)).toBe("visible");
});
