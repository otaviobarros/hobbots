import { expect, test } from "./hub.ts";
import { questHub, stopQuestHub } from "./quest-hub.ts";
import { openQuest, taskSheet } from "./work-sheet.ts";

// Issue #515: in a 960px window the quest and task sheets stop above the composer, so what you
// type stays in view and in reach while a sheet is open.

test.afterEach(stopQuestHub);
test.use({ viewport: { width: 960, height: 720 } });

// covers UX-001, CH-005
test("[TC-CH-264] at 960 wide the quest and task sheets end above the composer, which stays usable", async ({
  page,
}) => {
  const { url, aldric } = await questHub();
  await page.goto(`${url}/#/hobs/${aldric}/new`);
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  await composer.fill("Plan a Black Friday campaign for the shop");
  await composer.press("Enter");

  // How far the sheet's bottom sits above the composer's top, once it has slid in.
  const gapAbove = async (sheet: ReturnType<typeof page.getByRole>) => {
    const box = await sheet.boundingBox();
    const input = await composer.boundingBox();
    return box === null || input === null ? Number.NaN : input.y - (box.y + box.height);
  };
  const clearOf = async (sheet: ReturnType<typeof page.getByRole>) => {
    await expect(sheet).toBeVisible();
    await expect.poll(() => gapAbove(sheet)).toBeGreaterThanOrEqual(0);
    await expect
      .poll(async () => {
        const box = await sheet.boundingBox();
        return box === null ? Number.NaN : box.x + box.width;
      })
      .toBeLessThanOrEqual(960);
  };

  const quest = await openQuest(page, "Plan the Black Friday campaign");
  await clearOf(quest);
  await quest.getByRole("button", { name: /Ada · Build the campaign/ }).click();
  const task = taskSheet(page, "Build the campaign");
  await clearOf(task);

  // The composer still takes a message with the sheet open, and the sheet stays.
  await composer.fill("Thanks, keep going");
  await expect(composer).toHaveValue("Thanks, keep going");
  await expect(task).toBeVisible();
});
