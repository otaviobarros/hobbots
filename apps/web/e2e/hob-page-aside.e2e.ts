import { expect, test } from "./hub.ts";
import { questHub, stopQuestHub } from "./quest-hub.ts";

test.afterEach(stopQuestHub);

// covers CH-005, UX-001, UX-005
test("[TC-UX-131] a hob's page shows the Quests it leads, its backpack, its folders and its brain beside the chats", async ({
  page,
}) => {
  const { url, aldric } = await questHub();
  await page.goto(`${url}/#/hobs/${aldric}/chat`);
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  await composer.fill("Plan a Black Friday campaign for the shop");
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeVisible();

  await page.goto(`${url}/#/hobs/${aldric}`);
  const aside = page.getByRole("complementary", { name: "About Aldric" });

  // The Quest it leads, with how far its party got; it opens where the Quest is followed.
  const quests = aside.getByRole("region", { name: "Quests it leads" });
  const quest = quests.getByRole("link", { name: /Black Friday campaign/ });
  await expect(quest).toContainText(/\d of 2 done/, { timeout: 15_000 });

  // The backpack, then where it works and what it thinks with.
  await expect(aside.getByRole("region", { name: "Backpack" })).toBeVisible();
  const setup = aside.getByRole("region", { name: "Setup" });
  await expect(setup).toContainText("Works in");
  await expect(setup).toContainText("Claude Code");

  await quest.click();
  await expect(page).toHaveURL(new RegExp(`#/hobs/${aldric}/threads/`));
});
