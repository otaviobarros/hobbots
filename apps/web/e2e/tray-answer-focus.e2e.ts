import { expect, test } from "./hub.ts";
import { questHub, stopQuestHub } from "./quest-hub.ts";

test.afterEach(stopQuestHub);

test("answering in the chat's Needs-you tray moves focus to the composer once nothing else waits, and says what was sent (#995)", async ({
  page,
}) => {
  const { url, aldric } = await questHub();
  await page.goto(`${url}/#/hobs/${aldric}/chat`);
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  await composer.fill("Plan a Black Friday campaign for the shop");
  await composer.press("Enter");
  const tray = page.getByRole("region", { name: /^Needs you/ });
  const asks = tray.getByRole("region", { name: "Ada asks you" });
  await expect(asks).toBeVisible({ timeout: 15_000 });

  // The choice's key answers; the item leaves the tray with the control that had focus, and focus
  // goes to the composer rather than the page (#995).
  await asks.getByRole("button", { name: /^Dec 12 for international/ }).focus();
  await page.keyboard.press("1");
  await expect(asks).toHaveCount(0);
  await expect(composer).toBeFocused();
  await expect(
    page.getByRole("region", { name: /^Notifications/ }).getByText("Sent your answer to Ada: Dec 12 for international"),
  ).toBeVisible();
});
