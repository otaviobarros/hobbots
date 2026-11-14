import type { Page } from "@playwright/test";
import { expect, test } from "./hub.ts";
import { api, hubCall, party, registerPartyHooks, send, startWork, stuck, type Tasks } from "./party.ts";
import { openQuest, questMenu, questSheet } from "./quest-sheet.ts";

// Issue #1446 in the browser: you pause the quest from its sheet, or pause it now from its ⋯ menu,
// and resume it; and your @mention of a member goes straight to that member, without its lead. The
// hub's side is apps/server/test/pause-quest.test.ts.

registerPartyHooks();

const title = "Build the site";

/** Ada's Task waits on a blocker, so the quest is under way and stays so while the test runs. */
const underWay = [
  title,
  stuck("pages", "Ada", "Build the pages"),
  hubCall("wait_for", { key: "wait", tasks: ["$pages.task_id"] }),
];

/** Each Task's state in the thread's work, by its owner's id. */
const states = async (current: Parameters<typeof api>[0], thread: string) => {
  const { trees } = await api<Tasks>(current, "GET", `/api/threads/${thread}/tasks`);
  return Object.fromEntries(trees.flatMap((tree) => tree.tasks).map((task) => [task.ownerId, task.state]));
};

/** Presses a control with the keyboard, as someone without a pointer does. */
const press = async (page: Page, name: string) => {
  const control = questSheet(page, title).getByRole("button", { name, exact: true });
  await control.focus();
  await page.keyboard.press("Enter");
};

// covers OR-006, UX-001
test("[TC-UX-1446-01] Pause and Pause now hold the quest, its Paused banner says so, and Resume puts each hob back", async ({
  page,
  scan,
}) => {
  test.setTimeout(240_000);
  const { current, ids } = await party(["Ada"]);
  const { thread } = await startWork(page, current, ids, underWay, ["Ada"], "blocked");
  const sheet = await openQuest(page, title);

  await press(page, "Pause");
  const banner = sheet.getByRole("region", { name: "Paused" });
  await expect(banner).toContainText("No turn starts on this quest until you resume it.", { timeout: 30_000 });
  await expect
    .poll(() => states(current, thread), { timeout: 30_000 })
    .toEqual({
      [String(ids.Aldric)]: "paused",
      [String(ids.Ada)]: "paused",
    });
  await scan(sheet);

  await press(page, "Resume");
  await expect(banner).toBeHidden({ timeout: 30_000 });
  await expect(sheet.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
  await expect
    .poll(async () => (await states(current, thread))[String(ids.Ada)], { timeout: 30_000 })
    .not.toBe("paused");

  // Pause now is in the quest's ⋯ menu; it holds the quest the same way.
  await questMenu(page, title);
  await page.getByRole("menuitem", { name: "Pause now" }).click();
  await expect(banner).toBeVisible({ timeout: 30_000 });
  await press(page, "Resume");
  await expect(banner).toBeHidden({ timeout: 30_000 });
});

// covers IN-004, OR-002, STD-ARCH-019
test("[TC-UX-1446-02] an @mention of a member reaches that member, and its receipt starts there, never at the lead", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const { current, ids } = await party(["Ada"]);
  const { thread } = await startWork(page, current, ids, underWay, ["Ada"], "blocked");

  await send(page, ["@Ada use the blue theme"]);
  const receipt = page.getByRole("region", { name: "Where your message went" }).last();
  await expect(receipt).not.toContainText("Aldric got it");
  await expect(receipt).toContainText("Ada picked it up", { timeout: 60_000 });
  await expect(receipt.getByRole("status")).toContainText("Ada picked it up.");
  // Aldric is not woken for it: no reply of his answers your message. (Ada's turn may still wake him
  // with its own report, as any member's does.)
  const messages = await api<
    ReadonlyArray<{ readonly id: string; readonly content: string; readonly promptId: string | null }>
  >(current, "GET", `/api/threads/${thread}/messages`);
  const yours = messages.find((each) => each.content === "@Ada use the blue theme");
  expect(yours).toBeDefined();
  expect(messages.filter((each) => each.promptId === yours?.id)).toEqual([]);
});
