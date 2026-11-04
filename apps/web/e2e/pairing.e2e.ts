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

const finishSetup = async (current: Hub) => {
  const response = await fetch(`${current.url}/api/setup`, {
    method: "PATCH",
    headers: { ...current.headers, "content-type": "application/json" },
    body: JSON.stringify({ completed: true }),
  });
  expect(response.ok).toBe(true);
};

// covers DP-004
test("[TC-DP-115] a browser waits with a code, and after Allow on an approved device it works without asking again", async ({
  page,
  browser,
}) => {
  const current = await startHub(dataDir);
  hub = current;
  await finishSetup(current);

  // A browser with no device lands on the pairing screen, which suggests its name.
  const stranger = await browser.newContext();
  const newcomer = await stranger.newPage();
  await newcomer.goto(current.url);
  await expect(newcomer).toHaveURL(/#\/pair$/);
  const name = newcomer.getByLabel("Name this device");
  await expect(name).toHaveValue(/^Chrome on /);
  await name.fill("Kitchen laptop");
  await newcomer.getByRole("button", { name: "Ask for access" }).click();
  await expect(newcomer.getByRole("heading", { name: /^Waiting for approval on / })).toBeVisible();
  const code = (await newcomer.getByText(/^\d{3} \d{3}$/).textContent()) ?? "";
  expect(code).toMatch(/^\d{3} \d{3}$/);

  // An approved device sees it first in Needs you, with the same code, and allows it.
  await page.goto(`${current.url}/#/inbox`);
  const asking = page.getByRole("article", { name: "Kitchen laptop asks to use Hobbots" });
  await expect(asking).toBeVisible();
  await expect(asking.getByText(code, { exact: true })).toBeVisible();
  await expect(asking.getByText("From this computer")).toBeVisible();
  await asking.getByRole("button", { name: "Allow", exact: true }).click();
  await expect(asking).toBeHidden();

  // The waiting browser opens Hobbots by itself, and stays in after a reload.
  await expect(newcomer).not.toHaveURL(/#\/pair$/, { timeout: 10_000 });
  await expect(newcomer.getByRole("navigation")).toBeVisible();
  await newcomer.reload();
  await expect(newcomer).not.toHaveURL(/#\/pair$/);
  await expect(newcomer.getByRole("navigation")).toBeVisible();
  await stranger.close();
});

// covers DP-004
test("[TC-DP-116] a denied browser is told so and can ask again later", async ({ page, browser }) => {
  const current = await startHub(dataDir);
  hub = current;
  await finishSetup(current);

  const stranger = await browser.newContext();
  const newcomer = await stranger.newPage();
  await newcomer.goto(current.url);
  await newcomer.getByRole("button", { name: "Ask for access" }).click();
  await expect(newcomer.getByRole("heading", { name: /^Waiting for approval on / })).toBeVisible();

  await page.goto(`${current.url}/#/inbox`);
  await page.getByRole("button", { name: "Deny", exact: true }).click();

  await expect(newcomer.getByRole("heading", { name: /^Not allowed on / })).toBeVisible({ timeout: 10_000 });
  // Asking again within the minute is refused with how long to wait, and creates no prompt.
  await newcomer.getByRole("button", { name: "Ask again" }).click();
  await newcomer.getByRole("button", { name: "Ask for access" }).click();
  await expect(newcomer.getByRole("heading", { name: "Too many requests" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("article", { name: /asks to use Hobbots$/ })).toHaveCount(0);
  await stranger.close();
});

// The hub's own window, as the desktop app's preload names it.
const asDesktop = () => {
  (window as unknown as Record<string, unknown>).hobbots = { onOpenRequest: () => () => undefined };
};

// covers DP-004
test("[TC-DP-122] the prompt over the hub's window keeps the keyboard inside it until it is answered, then gives focus back", async ({
  page,
  browser,
}) => {
  const current = await startHub(dataDir);
  hub = current;
  await finishSetup(current);
  await page.addInitScript(asDesktop);
  await page.goto(`${current.url}/#/inbox`);
  await expect(page.getByRole("navigation", { name: "Sections" })).toBeVisible();
  // Where the keyboard was before each prompt: it comes back there once the prompt closes.
  const before = page.getByRole("navigation", { name: "Sections" }).getByRole("link").first();
  const strangers: Array<{ close: () => Promise<void> }> = [];
  const askAs = async (name: string) => {
    await before.focus();
    const stranger = await browser.newContext();
    strangers.push(stranger);
    const newcomer = await stranger.newPage();
    await newcomer.goto(current.url);
    await newcomer.getByLabel("Name this device").fill(name);
    await newcomer.getByRole("button", { name: "Ask for access" }).click();
    const prompt = page.getByRole("dialog", { name: "A device wants to join" });
    await expect(prompt).toBeVisible();
    await expect(prompt.getByText(name, { exact: true })).toBeVisible();
    await expect(prompt.getByRole("heading", { name: "A device wants to join" })).toBeFocused();
    // The prompt pops in, growing in steps for under half a second. Each step holds still long
    // enough to pass for stable, so a click can press a button on one step and release it on the
    // next, where it no longer is, and no click happens. Answer it once it has settled.
    await prompt.evaluate((dialog) => Promise.all(dialog.getAnimations().map((animation) => animation.finished)));
    return prompt;
  };

  // Decide later closes the prompt and the keyboard is back where it was.
  const first = await askAs("Kitchen laptop");
  await first.getByRole("button", { name: "Decide later" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(before).toBeFocused();

  const second = await askAs("Garden tablet");
  // Tab and Shift+Tab go round the prompt's own buttons, never to the page behind it.
  const insidePrompt = () =>
    page.evaluate(() => document.querySelector('[role="dialog"]')?.contains(document.activeElement) ?? false);
  for (const key of ["Tab", "Tab", "Tab", "Tab", "Shift+Tab", "Shift+Tab", "Shift+Tab", "Shift+Tab"]) {
    await page.keyboard.press(key);
    expect(await insidePrompt()).toBe(true);
  }
  // Escape does not answer for the user.
  await page.keyboard.press("Escape");
  await expect(second).toBeVisible();
  await second.getByRole("button", { name: "Allow", exact: true }).click();
  const allowed = page.getByRole("dialog", { name: "Garden tablet can use Hobbots now" });
  await expect(allowed.getByRole("button", { name: "Done" })).toBeFocused();
  // Once answered, Escape closes it like Done.
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(before).toBeFocused();

  const third = await askAs("Hall speaker");
  await third.getByRole("button", { name: "Not mine", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Hall speaker was turned away" })
    .getByRole("button", { name: "Done" })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(before).toBeFocused();
  for (const stranger of strangers) await stranger.close();
});
