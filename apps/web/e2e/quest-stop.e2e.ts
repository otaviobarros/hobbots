import { expect, test } from "./hub.ts";
import { questHub, stopQuestHub } from "./quest-hub.ts";
import { lane, openQuest, ticket } from "./quest-sheet.ts";

test.afterEach(stopQuestHub);

// covers OR-004, OR-006, UX-001
test("[TC-UX-1346-07] a Quest its lead stopped at your request reads stopped, with its summary, never finished", async ({
  page,
  scan,
}) => {
  const { url, aldric } = await questHub();
  await page.goto(`${url}/#/hobs/${aldric}/chat`);
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  await composer.fill("Plan a Black Friday campaign for the shop");
  await composer.press("Enter");
  const title = "Plan the Black Friday campaign";
  await openQuest(page, title);
  await expect(lane(page, "Quill")).toContainText("Draft the landing copy", { timeout: 15_000 });
  await page.keyboard.press("Escape");

  // You ask Aldric to stop: he stops the Quest, and everything under it is cancelled.
  await composer.fill("Please stop the quest, we are not doing Black Friday");
  await composer.press("Enter");
  await expect(page.getByRole("main", { name: "Chat" })).toContainText(
    "I stopped the Black Friday campaign as you asked.",
    { timeout: 15_000 },
  );
  await expect(ticket(page, title)).toContainText("Stopped at your request after", { timeout: 15_000 });
  await expect(ticket(page, title)).not.toContainText("Finished");
  await scan();

  const quest = await openQuest(page, title);
  const stopped = quest.getByRole("region", { name: "Stopped at your request" });
  await expect(stopped).toBeVisible();
  await expect(stopped).toContainText("Quill drafted the landing copy. The launch email was not scheduled.");
  await expect(stopped).toContainText("Why: You asked to stop the campaign");
  await expect(quest.getByRole("region", { name: "Quest finished" })).toHaveCount(0);
  await scan(quest);
});
