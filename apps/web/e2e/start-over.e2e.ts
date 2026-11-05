import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { admit, emptyDataDir, expect, type Hub, removeDataDir, startHub, test } from "./hub.ts";

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
}) => {
  test.setTimeout(90_000);
  const dataDir = emptyDataDir();
  folders.push(dataDir);
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
  await dialog.getByRole("checkbox").check();
  await remove.click();

  // The hub forgets everything and answers again as a new installation, with no hobs.
  const done = page.getByRole("dialog", { name: "All clear" });
  await expect(done).toBeVisible({ timeout: 30_000 });
  expect(fileOf(dataDir, "installation-id")).not.toBe(installation);
  expect(existsSync(join(dataDir, "reset.json"))).toBe(false);

  // This browser was a device of the old hub, so it pairs with the new one, and Start fresh opens Welcome.
  await context.clearCookies();
  await admit(context, { ...hub, headers: { authorization: `Bearer ${fileOf(dataDir, "window-key")}` } });
  await done.getByRole("button", { name: "Start fresh" }).click();
  await expect(page.getByRole("link", { name: "Get started" })).toBeVisible({ timeout: 20_000 });
});
