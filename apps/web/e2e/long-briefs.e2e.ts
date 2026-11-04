import type { Locator } from "@playwright/test";
import { expect, test } from "./hub.ts";
import { questHub, stopQuestHub } from "./quest-hub.ts";

test.afterEach(stopQuestHub);

/** Fails when the element, or anything in it that scrolls, is wider than its box. */
const expectNoSideScroll = async (element: Locator) => {
  const wide = await element.evaluate((root) =>
    [root, ...root.querySelectorAll("*")]
      .filter((each) => ["auto", "scroll"].includes(getComputedStyle(each).overflowX))
      .filter((each) => each.scrollWidth > each.clientWidth + 1)
      .map((each) => `${each.tagName.toLowerCase()}.${each.className}`),
  );
  expect(wide).toEqual([]);
};

/** The element's box, which the test needs on screen. */
const box = async (element: Locator) => {
  const found = await element.boundingBox();
  if (found === null) throw new Error("The element has no box.");
  return found;
};

/** Fails when `inner` reaches past the end of `outer`. */
const expectInside = async (inner: Locator, outer: Locator) => {
  const [a, b] = [await box(inner), await box(outer)];
  expect(a.x + a.width).toBeLessThanOrEqual(b.x + b.width + 1);
};

/** How many lines of text the element shows. */
const lines = (element: Locator) =>
  element.evaluate((each) => Math.round(each.clientHeight / Number.parseFloat(getComputedStyle(each).lineHeight)));

// covers UX-001
test("[TC-UX-163] a Task whose brief is a paragraph with a deep folder fits the chat, its cards and the task sheet", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const { url, aldric } = await questHub();
  await page.goto(`${url}/#/hobs/${aldric}/new`);
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  await composer.fill("Plan the campaign from a long brief");
  await composer.press("Enter");

  // The quest button in the chat's header keeps the Quest's title to one line.
  const strip = page.getByRole("region", { name: "Work in progress" });
  expect(await lines(strip.getByText(/^Run the Black Friday campaign/))).toBe(1);

  // The task sheet's heading stops at three lines, and neither it nor the sheet runs past the edge.
  const tray = page.getByRole("region", { name: /^Needs you/ });
  await expect(tray.getByRole("region", { name: "Ada asks you" })).toBeVisible({ timeout: 15_000 });
  const card = page.getByRole("region", { name: /^Aldric's work on Run the Black Friday campaign/ });
  const adasRow = card.getByRole("button", { name: /^Look inside Build the campaign for the shop in/ });
  await adasRow.click();
  const sheet = page.getByRole("dialog", { name: /^Build the campaign for the shop in .*, task details$/ });
  const heading = sheet.getByRole("heading", { name: /^Build the campaign for the shop in/ });
  await expect(heading).toBeFocused();
  expect(await lines(heading)).toBeLessThanOrEqual(3);
  await expectInside(heading, sheet);
  await expectInside(sheet.getByRole("button", { name: /^Back to Run the Black Friday campaign/ }), sheet);
  await sheet.getByText("Everything in this task").click();
  await expect(sheet).toContainText("hobbots_manual_tests/black_friday_campaign_full_run");
  await expectNoSideScroll(sheet);

  // Back shows the quest in the same sheet, never closing it on the way (#894), and the quest's
  // heading stops at three lines too.
  const panel = page.locator('[data-slot="sheet-content"]');
  await panel.evaluate((each) => Object.assign(each, { stayedOpen: true }));
  await sheet.getByRole("button", { name: /^Back to Run the Black Friday campaign/ }).click();
  const quest = page.getByRole("dialog", { name: /^Run the Black Friday campaign .*, quest$/ });
  const questHeading = quest.getByRole("heading", { name: /^Run the Black Friday campaign/ });
  await expect(questHeading).toBeFocused();
  await expect(panel).toHaveJSProperty("stayedOpen", true);
  expect(await lines(questHeading)).toBeLessThanOrEqual(3);
  await expectInside(questHeading, quest);
  await quest.getByRole("button", { name: /^Ada · Build the campaign for the shop in/ }).click();
  await expect(heading).toBeFocused();
  await expect(panel).toHaveJSProperty("stayedOpen", true);
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();

  // Once answered, the question card in the chat names the Task in at most two lines, inside the card.
  const answer = tray.getByRole("textbox", { name: "Your answer to Ada" });
  await answer.fill("Yes, Dec 12.");
  await answer.press("Enter");
  const chat = page.getByRole("main", { name: "Chat" });
  const asks = chat.getByRole("region", { name: "Ada asks you" });
  await expect(asks).toContainText("Yes, Dec 12.");
  const about = asks.getByRole("button", { name: /^for Build the campaign for the shop in/ });
  await expectInside(about, asks);
  expect(await lines(about.locator("span"))).toBeLessThanOrEqual(2);

  // Nothing in the chat is wider than its column, so the transcript never scrolls sideways.
  await expectNoSideScroll(chat);

  // With the sheet open, the quest card's count and Open in Workbench stay clear of it, once the
  // sheet and the column have slid into place.
  await adasRow.click();
  await expect(sheet).toBeVisible();
  for (const end of [card.getByText(/of 2 done$/), card.getByRole("button", { name: "Open in Workbench" })]) {
    await expect(end).toBeVisible();
    await expect
      .poll(async () => {
        const [{ x, width }, { x: sheetStart }] = [await box(end), await box(sheet)];
        return x + width - sheetStart;
      })
      .toBeLessThanOrEqual(0);
  }
  await expectNoSideScroll(chat);
});
