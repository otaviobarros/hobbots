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
test("[TC-DP-100] a browser waits with a code, and after Allow on an approved device it works without asking again", async ({
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
  const asking = page.getByRole("region", { name: "Kitchen laptop asks to use Hobbots" });
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
test("[TC-DP-101] a denied browser is told so and can ask again later", async ({ page, browser }) => {
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
  await expect(page.getByRole("region", { name: /asks to use Hobbots$/ })).toHaveCount(0);
  await stranger.close();
});
