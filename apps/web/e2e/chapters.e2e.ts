import type { FocusRead } from "@hobbots/api";
import type { Chapter } from "@hobbots/domain";
import type { Page } from "@playwright/test";
import { expectAccessible } from "./accessibility.ts";
import { expect, test } from "./hub.ts";
import { aldricHub, script, stopAldricHub } from "./workbench-hub.ts";

// Issue #1382 (ADR 037): a thread's chapters in the browser, on the fake runtime. A divider marks
// where each chapter starts; a resting chapter folds to its summary and opens on Show; Merge with
// previous sits on a divider's ⋯ menu and Split here on a message's. The Focus chip in the header
// lists what the hob reads each turn, as that turn's `PackReport` says.

test.afterEach(stopAldricHub);

/**
 * Sends `lines` as one message to Aldric and waits until his reply, which echoes them, has ended.
 * A new session's reply echoes its context pack first.
 */
const say = async (page: Page, lines: ReadonlyArray<string>) => {
  const main = page.getByRole("main", { name: "Chat" });
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  await composer.fill(lines.join("\n"));
  await composer.press("Enter");
  await expect(main.getByRole("article").filter({ hasText: lines[0]?.slice(0, 40) ?? "" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
};

const threadOf = (page: Page) => new URL(page.url()).hash.split("/threads/")[1] ?? "";

// covers CH-001, ADR 037 (Chapters)
test("[TC-CH-1382-01] shows a divider after start_chapter, folds and opens a resting chapter, and merges and splits", async ({
  page,
}) => {
  const { url, aldric, hub } = await aldricHub();
  const main = page.getByRole("main", { name: "Chat" });
  await page.goto(`${url}/#/hobs/${aldric}/chat`);
  await say(page, ["My cat is called Miso."]);
  await expect(page).toHaveURL(new RegExp(`#/hobs/${aldric}/threads/`));
  // One topic so far: no divider, and the chip names no chapter.
  await expect(main.getByRole("region", { name: "Chapter 1" })).toHaveCount(0);
  await expect(main.getByRole("button", { name: "Focus", exact: true })).toBeVisible();

  // The hob starts a chapter: its divider appears, and the reply that started it stays in view.
  await say(page, ["Now the garden.", script("start_chapter", { key: "garden", title: "The garden" })]);
  const garden = main.getByRole("region", { name: "The garden" });
  await expect(garden).toBeVisible();
  await expect(main.getByText("Echo: My cat is called Miso.")).toBeVisible();
  await expect(main.getByRole("button", { name: "Focused on The garden · 1 resting" })).toBeVisible();

  // Once the new chapter has a message, the resting one folds to its line, and opens on Show.
  await say(page, ["What should I plant?"]);
  const first = main.getByRole("region", { name: "Chapter 1" });
  await expect(first).toContainText("Resting");
  await expect(main.getByText("Echo: My cat is called Miso.")).toBeHidden();
  await expectAccessible(page, main);
  await first.getByRole("button", { name: "Show Chapter 1" }).click();
  await expect(main.getByText("Echo: My cat is called Miso.")).toBeVisible();
  await main.getByRole("button", { name: "Fold Chapter 1" }).click();
  await expect(main.getByText("Echo: My cat is called Miso.")).toBeHidden();

  // Merge with previous, from the divider's menu: one chapter again, so no divider.
  await garden.getByRole("button", { name: "More for The garden" }).click();
  await page.getByRole("menuitem", { name: "Merge with previous" }).click();
  await expect(garden).toBeHidden();
  await expect(main.getByText("Echo: My cat is called Miso.")).toBeVisible();
  const chapters = async () =>
    (
      (await (
        await fetch(`${url}/api/threads/${threadOf(page)}/chapters`, { headers: hub.headers })
      ).json()) as ReadonlyArray<Chapter>
    ).map((chapter) => [chapter.title, chapter.state]);
  await expect.poll(chapters).toEqual([[null, "live"]]);

  // Split here, from a message's menu: the new chapter needs a title.
  const asked = main.getByText("What should I plant?", { exact: true });
  await asked.locator("xpath=..").getByRole("button", { name: "More for this message" }).click();
  await page.getByRole("menuitem", { name: "Split here" }).click();
  const sheet = page.getByRole("dialog", { name: "Start a new chapter here" });
  await expectAccessible(page, sheet);
  await sheet.getByRole("button", { name: "Split here" }).click();
  await expect(sheet.getByRole("alert")).toHaveText("Give the chapter a title.");
  await sheet.getByRole("textbox", { name: "Chapter title" }).fill("Planting");
  await sheet.getByRole("button", { name: "Split here" }).click();
  await expect(sheet).toBeHidden();
  await expect(main.getByRole("region", { name: "Planting" })).toBeVisible();
  await expect(main.getByRole("region", { name: "Chapter 1" })).toContainText("Resting");
  await expect.poll(chapters).toEqual([
    [null, "resting"],
    ["Planting", "live"],
  ]);

  // A search result in a chapter you folded opens that chapter, so the chat can scroll to it.
  await main.getByRole("button", { name: "Show Chapter 1" }).click();
  await main.getByRole("button", { name: "Fold Chapter 1" }).click();
  await expect(main.getByText("Echo: My cat is called Miso.")).toBeHidden();
  // Picking the same result again, after you folded it once more, opens it again.
  const pickMiso = async () => {
    await page.getByRole("button", { name: "Find", exact: true }).click();
    await page.getByRole("searchbox", { name: "Find" }).fill("Miso");
    await page
      .getByRole("region", { name: /^Messages · / })
      .getByRole("button", { name: /^My cat is called Miso\. Message · You · / })
      .click();
    await expect(main.getByText("My cat is called Miso.", { exact: true })).toBeInViewport();
    // It folds again as before.
    await main.getByRole("button", { name: "Fold Chapter 1" }).click();
    await expect(main.getByText("Echo: My cat is called Miso.")).toBeHidden();
  };
  await pickMiso();
  await pickMiso();
});

// covers ADR 037 (Chapters, Focus chip), STD-REACT-015
test("[TC-CH-1382-05] a chat whose chapters can't be read says so and reads them again, and a narrow header keeps the Focus chip", async ({
  page,
}) => {
  const { url, aldric } = await aldricHub();
  const main = page.getByRole("main", { name: "Chat" });
  await page.goto(`${url}/#/hobs/${aldric}/chat`);
  await say(page, ["Now the garden.", script("start_chapter", { key: "garden", title: "The garden" })]);
  await expect(main.getByRole("region", { name: "The garden" })).toBeVisible();

  // The chapters read fails: the transcript still shows, undivided, and says why.
  const list = "**/api/threads/*/chapters";
  await page.route(list, (route) => route.fulfill({ status: 500, body: "" }));
  await page.reload();
  const failed = main.getByText("Couldn't read this chat's chapters, so it shows without them.");
  await expect(failed).toBeVisible({ timeout: 20_000 });
  await expect(main.getByRole("article").filter({ hasText: "Now the garden." }).first()).toBeVisible();
  await page.unroute(list);
  await main.getByRole("button", { name: "Try again" }).click();
  await expect(failed).toBeHidden();
  await expect(main.getByRole("region", { name: "The garden" })).toBeVisible();

  // In a narrow header the chip keeps only its dot, and still opens what the hob reads.
  await page.setViewportSize({ width: 390, height: 844 });
  const chip = main.getByRole("button", { name: "Focused on The garden · 1 resting" });
  await expect(chip).toBeVisible();
  await expect(chip.getByText("Focused on The garden · 1 resting")).toBeHidden();
  await chip.click();
  await expect(page.getByRole("dialog", { name: "What Aldric reads each turn" })).toBeVisible();
});

/** The size the chip shows for a number of tokens. */
const tokens = (count: number) => (count === 1 ? "1 token" : `${count.toLocaleString("en-US")} tokens`);

// covers ADR 037 (The context pack, Focus chip)
test("[TC-CH-1382-02] the Focus chip lists the parts and sizes of the turn's PackReport, with its trim", async ({
  page,
}) => {
  const { url, aldric, hub } = await aldricHub();
  const main = page.getByRole("main", { name: "Chat" });
  await page.goto(`${url}/#/hobs/${aldric}/chat`);
  await say(page, ["Hello."]);
  // One long word, so the fake streams it at once. It moves into a chapter of its own, whose first
  // turn starts a new session from the pack; the live chapter holds it and its echo, far longer than
  // their share, so the pack cuts the last one in the middle.
  await say(page, [`The long read. ${"a".repeat(60_000)}`]);
  const [, longOne] = (await (
    await fetch(`${url}/api/threads/${threadOf(page)}/messages`, { headers: hub.headers })
  ).json()) as ReadonlyArray<{ readonly id: string }>;
  const split = await fetch(`${url}/api/threads/${threadOf(page)}/chapters/split`, {
    method: "POST",
    headers: { "content-type": "application/json", ...hub.headers },
    body: JSON.stringify({ key: "long", messageId: longOne?.id, title: "A long read" }),
  });
  expect(split.status).toBe(200);
  await say(page, ["Next."]);

  const read = (await (
    await fetch(`${url}/api/threads/${threadOf(page)}/focus`, { headers: hub.headers })
  ).json()) as FocusRead;
  expect(read.of).toBe("last-turn");
  const live = read.report.parts.find((part) => part.part === "live-chapter");
  expect(live?.trimmed?.cutCharacters).toBeGreaterThan(0);

  await main.getByRole("button", { name: "Focused on A long read · 1 resting" }).click();
  const chip = page.getByRole("dialog", { name: "What Aldric reads each turn" });
  await expect(chip).toContainText(
    `The last new session read ${tokens(read.report.tokens)} of its ${tokens(read.report.budget)}.`,
  );
  const rows = chip.getByRole("list", { name: "What Aldric reads each turn" }).locator(":scope > li");
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toHaveAccessibleName("Always");
  await expect(rows.nth(1)).toHaveAccessibleName("This chat");
  await expect(rows.nth(2)).toHaveAccessibleName("Carried");
  // Every part of the report shows with its size, in the report's order within its row.
  const sizes = await rows.locator("ul > li").allInnerTexts();
  expect(sizes).toHaveLength(read.report.parts.length);
  const byRow = [
    "memory-brief",
    "members",
    "camp-brief",
    "decisions",
    "open-work",
    "artifacts",
    "chapters",
    "live-chapter",
    "carried",
  ];
  const ordered = byRow.flatMap((name) => read.report.parts.filter((part) => part.part === name));
  for (const [index, part] of ordered.entries()) expect(sizes[index]).toContain(tokens(part.tokens));
  await expect(chip).toContainText(
    `${(live?.trimmed?.cutCharacters ?? 0).toLocaleString("en-US")} characters cut from the middle of a long message.`,
  );
  await expectAccessible(page, chip);
  await chip.getByRole("button", { name: "Close" }).click();
  await expect(chip).toBeHidden();
});
