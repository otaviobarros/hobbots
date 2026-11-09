import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { emptyDataDir, expect, type Hub, removeDataDir, startHub, test } from "./hub.ts";

let hub: Hub | undefined;
const folders: Array<string> = [];

test.afterEach(async () => {
  await hub?.stop();
  hub = undefined;
  for (const folder of folders.splice(0)) removeDataDir(folder);
});

/** A small file the hub on `dataDir` wrote, such as its installation ID or its latest window key. */
const fileOf = (dataDir: string, name: string) => readFileSync(join(dataDir, name), "utf8").trim();

// covers #948
test("[TC-OP-098] starts over from Settings › Your data, and the hub comes back empty at Welcome", async ({
  page,
  context,
  browser,
}) => {
  test.setTimeout(90_000);
  const dataDir = emptyDataDir();
  const destination = emptyDataDir();
  folders.push(dataDir, destination);
  hub = await startHub(dataDir);
  const api = async (method: string, path: string, body: unknown) => {
    const response = await fetch(`${hub?.url}/api${path}`, {
      method,
      headers: { "content-type": "application/json", ...hub?.headers },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
  };
  await api("PATCH", "/setup", { completed: true, connectedProviders: ["claude-code"] });
  await api("POST", "/agents", {
    id: randomUUID(),
    name: "Pip",
    role: "assistant",
    roleTitle: "Assistant",
    sigil: "assistant",
    hat: null,
    tool: null,
    lookSeed: 4000,
    lookColor: "amber",
    runtime: "claude-code",
    model: null,
    effort: null,
    instructions: "",
  });
  const installation = fileOf(dataDir, "installation-id");

  // Before a folder is chosen, Back up first names the hub's default folder as that, never as chosen (#1220).
  await page.goto(`${hub.url}/#/settings/data`);
  await page.getByRole("region", { name: "Start over" }).getByRole("button", { name: "Delete everything…" }).click();
  const first = page.getByRole("dialog", { name: "Delete everything and start over?" });
  await expect(
    first.getByText("To save it somewhere else, choose a folder under Backups.", { exact: false }),
  ).toBeVisible();
  await expect(first.getByText("the folder chosen under Backups", { exact: false })).toHaveCount(0);
  await first.getByRole("button", { name: "Keep my data" }).click();
  await expect(first).toBeHidden();

  // Backups saves to a folder the person chose, and so does Back up first.
  await page
    .getByRole("region", { name: "Backups" })
    .getByRole("textbox", { name: "Save the backup in" })
    .fill(destination);

  // Find a setting knows it by other names, and it sits at the bottom of Your data.
  await page.goto(`${hub.url}/#/settings`);
  await page.getByRole("searchbox", { name: "Find a setting" }).fill("reset");
  await page.getByRole("link", { name: /^Start over/ }).click();
  await expect(page).toHaveURL(/#\/settings\/data$/);
  const card = page.getByRole("region", { name: "Start over" });
  await card.getByRole("button", { name: "Delete everything…" }).click();

  // The dialog says what goes and what stays, and waits for the check box.
  const dialog = page.getByRole("dialog", { name: "Delete everything and start over?" });
  await expect(dialog.getByRole("list", { name: "What goes" })).toContainText("Your hob and its chats");
  await expect(dialog.getByRole("list", { name: "What stays" })).toContainText(
    "Your folders and the files hobs made in them",
  );
  const remove = dialog.getByRole("button", { name: "Delete everything", exact: true });
  await expect(remove).toBeDisabled();
  await dialog.getByRole("button", { name: "Keep my data" }).click();
  await expect(dialog).toBeHidden();

  await card.getByRole("button", { name: "Delete everything…" }).click();
  await expect(
    dialog.getByText(`Saves to ${destination}, the folder chosen under Backups.`, { exact: false }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Back up first" }).click();
  await expect(dialog.getByRole("button", { name: "Backed up" })).toBeVisible({ timeout: 20_000 });
  await expect(dialog.getByText(` to ${join(destination, "Hobbots backup ")}`, { exact: false })).toBeVisible();
  await dialog.getByRole("checkbox").check();
  await remove.click();

  // The hub forgets everything and answers again as a new installation, with no hobs.
  const done = page.getByRole("dialog", { name: "All clear" });
  await expect(done).toBeVisible({ timeout: 30_000 });
  expect(fileOf(dataDir, "installation-id")).not.toBe(installation);
  expect(existsSync(join(dataDir, "reset.json"))).toBe(false);

  // The hub forgot this browser: its old device no longer gets in.
  const cookies = (await context.cookies(hub.url)).map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
  expect((await fetch(`${hub.url}/api/setup`, { headers: { cookie: cookies } })).status).toBe(401);

  // So it asks to be allowed again, and the hub's own window allows it, as on a first visit.
  await expect(done).toContainText("This browser was one of the devices the hub forgot");
  await done.getByRole("button", { name: "Ask to be allowed" }).click();
  await page.getByRole("button", { name: "Ask for access" }).click();
  const code = (await page.getByText(/^\d{3} \d{3}$/).textContent()) ?? "";
  const hubWindow = await browser.newContext({
    extraHTTPHeaders: { authorization: `Bearer ${fileOf(dataDir, "window-key")}` },
  });
  const inbox = await hubWindow.newPage();
  await inbox.goto(`${hub.url}/#/inbox`);
  const asking = inbox.getByRole("article", { name: /asks to use Hobbots$/ });
  await expect(asking.getByText(code, { exact: true })).toBeVisible({ timeout: 20_000 });
  await asking.getByRole("button", { name: "Allow", exact: true }).click();
  await hubWindow.close();

  // Allowed, the browser opens the new hub at Welcome.
  await expect(page.getByRole("link", { name: "Get started" })).toBeVisible({ timeout: 20_000 });
});

/** A hub whose setup is done, so Start over has something to forget. */
const setUpHub = async () => {
  const dataDir = emptyDataDir();
  folders.push(dataDir);
  hub = await startHub(dataDir);
  const response = await fetch(`${hub.url}/api/setup`, {
    method: "PATCH",
    headers: { "content-type": "application/json", ...hub.headers },
    body: JSON.stringify({ completed: true, connectedProviders: ["claude-code"] }),
  });
  expect(response.ok).toBe(true);
  return { dataDir, url: hub.url };
};

/** Settings › Your data › Delete everything, confirmed: the dialog then shows the deleting steps. */
const deleteEverything = async (page: Page, url: string) => {
  await page.goto(`${url}/#/settings/data`);
  await page.getByRole("region", { name: "Start over" }).getByRole("button", { name: "Delete everything…" }).click();
  const dialog = page.getByRole("dialog", { name: "Delete everything and start over?" });
  await dialog.getByRole("checkbox").check();
  await dialog.getByRole("button", { name: "Delete everything", exact: true }).click();
};

/** The browser the hub forgot lands on the pairing screen at the app's root, not on Settings. */
const expectPairing = async (page: Page, url: string) => {
  await expect(page.getByRole("button", { name: "Ask for access" })).toBeVisible({ timeout: 20_000 });
  await expect(page).toHaveURL(`${url}/#/pair`);
};

// covers #1220
test("[TC-OP-1220-01] closing All clear with Escape starts fresh, as its button does", async ({ page }) => {
  test.setTimeout(60_000);
  const { url } = await setUpHub();
  await deleteEverything(page, url);
  const done = page.getByRole("dialog", { name: "All clear" });
  await expect(done).toBeVisible({ timeout: 30_000 });
  await page.keyboard.press("Escape");
  await expectPairing(page, url);
});

// covers #1220
test("[TC-OP-1220-02] closing All clear by clicking outside it starts fresh too", async ({ page }) => {
  test.setTimeout(60_000);
  const { url } = await setUpHub();
  await deleteEverything(page, url);
  const done = page.getByRole("dialog", { name: "All clear" });
  await expect(done).toBeVisible({ timeout: 30_000 });
  await page.mouse.click(4, 4);
  await expectPairing(page, url);
});

// covers #1220
test("[TC-OP-1220-03] a Start over whose dialog the window lost on the way still ends at Welcome", async ({
  browser,
}) => {
  test.setTimeout(60_000);
  const { dataDir, url } = await setUpHub();
  // The hub's own window: it signs every request with the window key of the hub answering now, as the
  // desktop app sets its key again after the restart.
  // Once Start over has begun, its checks that the hub answers again wait until the window has gone
  // elsewhere, so the restart cannot finish while the dialog is still there.
  let key = fileOf(dataDir, "window-key");
  let resetting = false;
  let release = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const hubWindow = await browser.newContext();
  await hubWindow.route(`${url}/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "POST" && path.endsWith("/reset")) resetting = true;
    else if (resetting && path.endsWith("/health")) await released;
    if (existsSync(join(dataDir, "window-key"))) key = fileOf(dataDir, "window-key");
    await route.continue({ headers: { ...request.headers(), authorization: `Bearer ${key}` } });
  });
  const page = await hubWindow.newPage();
  try {
    await deleteEverything(page, url);
    // While the hub deletes, the window goes elsewhere and Settings, with the dialog, is gone.
    await expect(page.getByRole("dialog", { name: "Deleting everything…" })).toHaveAttribute("aria-busy", "true");
    await page.evaluate(() => {
      Object.assign(globalThis, { stayedOnPage: true });
      globalThis.location.hash = "#/inbox";
    });
    await expect(page.getByRole("dialog")).toHaveCount(0);
    release();
    // Once the hub answers again, the window opens it afresh at Welcome.
    await expect(page.getByRole("link", { name: "Get started" })).toBeVisible({ timeout: 30_000 });
    expect(await page.evaluate(() => "stayedOnPage" in globalThis)).toBe(false);
  } finally {
    release();
    await hubWindow.close();
  }
});
