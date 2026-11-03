import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { admit, emptyDataDir, expect, type Hub, removeDataDir, startHub, test } from "./hub.ts";

let hub: Hub | undefined;
const folders: Array<string> = [];

test.afterEach(async () => {
  await hub?.stop();
  hub = undefined;
  for (const folder of folders.splice(0)) removeDataDir(folder);
});

/** A hub past setup that plays the scripted Black Friday Quest with Aldric, Quill and Ada. */
const partyHub = async (dataDir: string) => {
  const started = await startHub(dataDir, { HOBBOTS_FAKE_QUEST: "black-friday" });
  const api = async (method: string, path: string, body: unknown) => {
    const response = await fetch(`${started.url}/api${path}`, {
      method,
      headers: { "content-type": "application/json", ...started.headers },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
    return response.json() as Promise<{ readonly id: string }>;
  };
  await api("PATCH", "/setup", { completed: true, connectedProviders: ["claude-code"] });
  const ids: Record<string, string> = {};
  for (const [index, name] of ["Aldric", "Quill", "Ada"].entries()) {
    const hob = await api("POST", "/agents", {
      id: randomUUID(),
      name,
      role: "assistant",
      roleTitle: "Assistant",
      sigil: "assistant",
      hat: null,
      tool: null,
      lookSeed: 4000 + index * 911,
      lookColor: (["amber", "sky", "moss"] as const)[index],
      runtime: "claude-code",
      model: null,
      effort: null,
      instructions: "",
    });
    ids[name] = hob.id;
  }
  return { hub: started, aldric: String(ids.Aldric) };
};

// covers OP-003
test("[TC-OP-036] backs up from Settings, and Welcome restores it after the data folder is deleted", async ({
  page,
  context,
}) => {
  test.setTimeout(120_000);
  const dataDir = emptyDataDir();
  const destination = emptyDataDir();
  folders.push(dataDir, destination);
  const party = await partyHub(dataDir);
  hub = party.hub;

  // Aldric's Quest runs until Ada asks a question, and the thread and its Tasks are saved.
  await page.goto(`${hub.url}/#/hobs/${party.aldric}/new`);
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  await composer.fill("Plan a Black Friday campaign for the shop");
  await composer.press("Enter");
  await expect(page.getByRole("region", { name: "Ada asks you" })).toBeVisible({ timeout: 20_000 });

  // Settings › Backup & export makes the backup and shows where it went.
  await page.goto(`${hub.url}/#/settings#backup`);
  const panel = page.getByRole("region", { name: "Backup & export" });
  await panel.getByRole("textbox", { name: "Save the backup in" }).fill(destination);
  await panel.getByRole("button", { name: "Back up now" }).click();
  await expect(panel.getByText(/^Backed up /)).toBeVisible({ timeout: 20_000 });
  const backup = (await panel.getByText(/\.hobbots-backup$/).textContent()) ?? "";
  expect(backup.startsWith(join(destination, "Hobbots backup "))).toBe(true);

  // The data folder is lost, and a new hub starts on an empty one.
  await hub.stop();
  removeDataDir(dataDir);
  mkdirSync(dataDir);
  // A new hub knows no device, so this browser pairs with it as with any new hub.
  await context.clearCookies();
  hub = await startHub(dataDir);
  const freshInstallation = readFileSync(join(dataDir, "installation-id"), "utf8").trim();
  await page.goto(hub.url);

  // Welcome reads the backup, says what it holds, and restores it once confirmed.
  await page.getByRole("button", { name: "Restore a backup" }).click();
  const dialog = page.getByRole("dialog", { name: "Restore from a backup" });
  await dialog.getByRole("textbox", { name: "Backup folder" }).fill(backup);
  await dialog.getByRole("button", { name: "Read the backup" }).click();
  await expect(dialog).toContainText("This backup holds");
  await expect(dialog).toContainText(/3 hobs, 1 thread, 1 Quest and \d+ Tasks/);
  await expect(dialog).toContainText("Devices, keychain items and runtime sign-ins do not come back");
  await dialog.getByRole("button", { name: "Restore and restart" }).click();
  await expect(dialog.getByRole("status")).toContainText("Restoring");

  // The restored hub revoked every device but its window, so this browser pairs again with it.
  const restoredKey = async () => {
    for (let tries = 0; tries < 100; tries++) {
      const health = await fetch(`${hub?.url}/api/health`).then(
        (response) => response.json() as Promise<{ readonly installationId?: string }>,
        () => undefined,
      );
      if (health?.installationId !== undefined && health.installationId !== freshInstallation) {
        return readFileSync(join(dataDir, "window-key"), "utf8").trim();
      }
      await new Promise((done) => setTimeout(done, 200));
    }
    throw new Error("The restored hub did not answer");
  };
  const key = await restoredKey();
  await context.clearCookies();
  await admit(context, { ...hub, headers: { authorization: `Bearer ${key}` } });
  await page.goto(hub.url);

  // Home holds the work from the backup until it is resumed, and the thread and its Quest are back.
  const held = page.getByRole("region", { name: "Work is held after a restore" });
  await expect(held).toBeVisible({ timeout: 20_000 });
  await page.goto(`${hub.url}/#/settings#backup`);
  const restored = page.getByRole("region", { name: "Backup & export" });
  await expect(restored).toContainText(/Restored .* from a backup made /);
  await expect(restored).toContainText("The data from before the restore");
  await expect(page.getByRole("region", { name: "Devices" })).toContainText(
    "Revoked by a restorePlaywrightOpen Hobbots on that device to ask again.",
  );
  await restored.getByRole("button", { name: "Resume work" }).click();
  await expect(restored).not.toContainText("Work is held after a restore");

  await page.goto(`${hub.url}/#/hobs/${party.aldric}`);
  await expect(page.getByText("Plan a Black Friday campaign for the shop").first()).toBeVisible();
  await expect(page.getByRole("region", { name: "Ada asks you" })).toBeVisible();
});
