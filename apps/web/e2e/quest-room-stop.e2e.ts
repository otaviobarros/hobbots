import { expect, test } from "./hub.ts";
import { questHub, stopQuestHub } from "./quest-hub.ts";
import { laneHead, openRoom, ticket } from "./quest-room.ts";

test.afterEach(stopQuestHub);

// covers OR-004, OR-006, UX-001
test("[TC-UX-1346-07] a Quest its lead stopped at your request reads stopped, with its summary, never finished", async ({
  page,
}) => {
  const { url, aldric } = await questHub();
  await page.goto(`${url}/#/hobs/${aldric}/chat`);
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  await composer.fill("Plan a Black Friday campaign for the shop");
  await composer.press("Enter");
  const title = "Plan the Black Friday campaign";
  const room = await openRoom(page, title);
  await expect(laneHead(page, "Quill")).toContainText("Draft the landing copy");

  // You ask Aldric to stop: he stops the Quest, and everything under it is cancelled.
  await composer.fill("Please stop the quest, we are not doing Black Friday");
  await composer.press("Enter");
  const stopped = room.getByRole("region", { name: "Stopped at your request" });
  await expect(stopped).toBeVisible({ timeout: 15_000 });
  await expect(stopped).toContainText("Quill drafted the landing copy. The launch email was not scheduled.");
  await expect(stopped).toContainText("Why: You asked to stop the campaign");
  await expect(room.getByRole("region", { name: "Quest finished" })).toHaveCount(0);
  await expect(ticket(page, title)).toContainText("Stopped at your request after");
  await expect(ticket(page, title)).not.toContainText("Finished");
  await expect(page.getByRole("main", { name: "Chat" })).toContainText(
    "I stopped the Black Friday campaign as you asked.",
  );
});
