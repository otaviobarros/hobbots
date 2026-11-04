import type { Locator } from "@playwright/test";
import { expect, test } from "./hub.ts";
import { questHub, stopQuestHub } from "./quest-hub.ts";
import { lane, laneHead } from "./quest-room.ts";

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
test("[TC-UX-163] a Task whose brief is a paragraph with a deep folder fits the chat, its cards and the Quest room", async ({
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

  // The room's heading keeps to one line inside the room, and Ada's lane holds the long brief
  // without running past its edge.
  const tray = page.getByRole("region", { name: /^Needs you/ });
  await expect(tray.getByRole("region", { name: "Ada asks you" })).toBeVisible({ timeout: 15_000 });
  const card = page.getByRole("region", { name: /^Aldric's work on Run the Black Friday campaign/ });
  const adasRow = card.getByRole("button", { name: /^Look inside Build the campaign for the shop in/ });
  await adasRow.click();
  const room = page.getByRole("region", { name: /^Run the Black Friday campaign .*, Quest room$/ });
  const heading = room.getByRole("heading", { name: /^Run the Black Friday campaign/ }).first();
  await expect(heading).toBeFocused();
  expect(await lines(heading)).toBe(1);
  await expectInside(heading, room);
  const ada = lane(page, "Ada");
  await expect(laneHead(page, "Ada")).toHaveAttribute("aria-pressed", "true");
  await expectInside(laneHead(page, "Ada"), ada);
  const task = ada.getByRole("region", { name: /^Build the campaign for the shop in/ }).first();
  await task.locator(":scope > details > summary").click();
  await expect(task).toContainText("hobbots_manual_tests/black_friday_campaign_full_run");
  await expectNoSideScroll(ada);
  await room.getByRole("button", { name: "Close room" }).click();
  await expect(room).toBeHidden();

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

  // With the room open beside it, the quest card's count and Open in Workbench stay inside the chat's column.
  await adasRow.click();
  await expect(room).toBeVisible();
  for (const end of [card.getByText(/of 2 done$/), card.getByRole("button", { name: "Open in Workbench" })]) {
    await expect(end).toBeVisible();
    await expectInside(end, chat);
  }
  await expectNoSideScroll(chat);
});
