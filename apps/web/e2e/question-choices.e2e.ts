import { expect, test } from "./hub.ts";
import { questHub, stopQuestHub } from "./quest-hub.ts";
import { lane, laneTask, openQuest } from "./quest-sheet.ts";

test.afterEach(stopQuestHub);

/** Starts the Black Friday Quest and waits for Ada's question, which offers two choices, to reach you. */
const startQuest = async (page: import("@playwright/test").Page) => {
  const { url, aldric } = await questHub();
  await page.goto(`${url}/#/hobs/${aldric}/chat`);
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  await composer.fill("Plan a Black Friday campaign for the shop");
  await composer.press("Enter");
  const asks = page.getByRole("region", { name: "Ada asks you" });
  await expect(asks).toBeVisible({ timeout: 15_000 });
  return asks;
};

// covers OR-003, OR-004, UX-001
test("[TC-UX-908] a member asks with choices, the question climbs to you, you pick one on its card, and the member goes on with it", async ({
  page,
}) => {
  const asks = await startQuest(page);

  // The card offers Ada's choices as buttons, the recommended one marked, and still a box for words.
  const choices = asks.getByRole("list", { name: "Ada's choices" });
  const recommended = choices.getByRole("button", { name: /^Dec 12 for international\s*Recommended/ });
  await expect(recommended).toContainText("International orders arrive before carriers stop.");
  await expect(choices.getByRole("button", { name: /^Dec 18 for everyone/ })).toBeVisible();
  await expect(asks).toContainText("or answer in your own words");
  await expect(asks.getByRole("textbox", { name: "Your answer to Ada" })).toBeVisible();

  // One click answers: the card keeps what you picked and what else was offered.
  await recommended.click();
  await expect(asks).toContainText("You picked here: Dec 12 for international");
  await expect(asks).toContainText("Also offered: Dec 18 for everyone");
  await expect(choices).toHaveCount(0);

  // In the fake Quest, Ada then says which choice she goes on with. That the answer reaches a member's
  // own turn through the tools is checked at hub level, in [TC-OR-580].
  await openQuest(page, "Plan the Black Friday campaign");
  await expect(lane(page, "Ada")).toContainText("Going with Dec 12 for international", { timeout: 30_000 });
});

// covers UX-001
test("[TC-UX-909] in Ada's lane the choices are chips, and a choice's number key picks it", async ({ page }) => {
  await startQuest(page);
  await openQuest(page, "Plan the Black Friday campaign");
  const asks = lane(page, "Ada").getByRole("region", { name: "Ada asks you" });
  const chips = asks.getByRole("list", { name: "Ada's choices" });
  const first = chips.getByRole("button", { name: /^Dec 12 for international, recommended/ });
  await expect(first).toHaveAttribute("title", "International orders arrive before carriers stop.");

  await first.focus();
  await page.keyboard.press("2");
  await expect(laneTask(page, "Build the campaign")).toContainText("You picked here: Dec 18 for everyone");
  await expect(lane(page, "Ada")).toContainText("Going with Dec 18 for everyone", { timeout: 30_000 });
});
