import type { Page } from "@playwright/test";
import { emptyDataDir, expect, type Hub, removeDataDir, startHub, test } from "./hub.ts";

let hub: Hub | undefined;
let dataDir = "";

test.beforeEach(() => {
  dataDir = emptyDataDir();
});

test.afterEach(async () => {
  await hub?.stop();
  hub = undefined;
  removeDataDir(dataDir);
});

/**
 * A set-up hub that puts its own two questions to you at start: nightly backups, with two choices,
 * and the hub's name, with none. Applying an answer asks a third that repeats what it applied.
 */
const hubThatAsks = async (page: Page) => {
  const current = await startHub(dataDir, { HOBBOTS_FAKE_HUB_QUESTIONS: "on" });
  hub = current;
  const response = await fetch(`${current.url}/api/setup`, {
    method: "PATCH",
    headers: { ...current.headers, "content-type": "application/json" },
    body: JSON.stringify({ completed: true, connectedProviders: ["claude-code"], safetyPreset: "balanced" }),
  });
  if (!response.ok) throw new Error(`Setup answered ${response.status}: ${await response.text()}`);
  await page.goto(`${current.url}/#/inbox?tab=needs`);
  return page.getByRole("list", { name: "Requests" });
};

const row = (list: ReturnType<Page["getByRole"]>, text: RegExp) => list.getByRole("link", { name: text });
const detail = (page: Page) => page.getByRole("article", { name: "Question from Your hub" });

// covers UX-001
test("[TC-UX-911] the hub asks you itself in the Inbox: a choice's key answers, typed words answer, a failed send keeps them, and the hub applies each", async ({
  page,
  scan,
}) => {
  const list = await hubThatAsks(page);
  await expect(row(list, /How often should the hub back up/)).toBeVisible({ timeout: 15_000 });
  await expect(row(list, /What should this hub be called/)).toBeVisible();

  // The hub's card: its own portrait and name, the subject, its choices with one recommended, and a box.
  await row(list, /How often should the hub back up/).click();
  const backups = detail(page);
  await expect(backups).toContainText("How often should the hub back up your data?");
  await expect(backups).toContainText("Nightly backups");
  await expect(backups).toContainText("Goes to your hub, which applies it.");
  const choices = backups.getByRole("list", { name: "your hub's choices" });
  await expect(choices.getByRole("button", { name: /^Every night/ })).toContainText("Recommended");
  await expect(choices.getByRole("button", { name: /^Every week/ })).toBeVisible();
  await scan();

  // Words typed for one question stay with it: the next question opens with an empty box.
  const box = (scope: ReturnType<typeof detail>) => scope.getByRole("textbox", { name: "Your answer to your hub" });
  await box(backups).fill("Only on weekdays");
  await row(list, /What should this hub be called/).click();
  await expect(detail(page)).toContainText("What should this hub be called on your other devices?");
  await expect(box(detail(page))).toHaveValue("");
  await row(list, /How often should the hub back up/).click();
  await expect(box(detail(page))).toHaveValue("");

  // A choice's number key answers while the card has focus outside the box, and the hub applies it.
  await detail(page)
    .getByRole("button", { name: /^Every night/ })
    .focus();
  await page.keyboard.press("1");
  await expect(row(list, /How often should the hub back up/)).toHaveCount(0);
  await expect(row(list, /The hub applied: Every night/)).toBeVisible({ timeout: 15_000 });
  await row(list, /The hub applied: Every night/).click();
  await box(detail(page)).fill("Thanks");
  await detail(page).getByRole("button", { name: "Send answer" }).click();
  await expect(row(list, /The hub applied/)).toHaveCount(0);

  // A send that cannot reach the hub says so and keeps your words; sending again answers.
  await row(list, /What should this hub be called/).click();
  const name = detail(page);
  await page.route("**/api/hub-questions/*/answer", (route) => route.abort("connectionrefused"));
  await box(name).fill("Kitchen Mac");
  await box(name).press("Enter");
  await expect(name.getByRole("alert")).toContainText("Your answer could not be sent. Try again.");
  await scan(name);
  await expect(box(name)).toHaveValue("Kitchen Mac");
  await page.unroute("**/api/hub-questions/*/answer");
  await name.getByRole("button", { name: "Send answer" }).click();
  await expect(row(list, /What should this hub be called/)).toHaveCount(0);
  await expect(row(list, /The hub applied: Kitchen Mac/)).toBeVisible({ timeout: 15_000 });
});

// covers UX-001
test("[TC-UX-912] Home's Needs you shows the hub's question with its choices, and picking one there answers it", async ({
  page,
  scan,
}) => {
  await hubThatAsks(page);
  await page.getByRole("link", { name: "Home", exact: true }).click();
  const needsYou = page.getByRole("region", { name: "Needs you", exact: true });
  const tray = needsYou.getByRole("region", { name: /^Needs you, \d of 2$/ });
  await expect(tray).toContainText("How often should the hub back up your data?", { timeout: 15_000 });
  await scan();
  await tray.getByRole("button", { name: /^Every week/ }).click();
  await expect(tray).toContainText("What should this hub be called on your other devices?");
  await expect(needsYou).not.toContainText("How often should the hub back up your data?");
});
