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

const finishSetup = (current: Hub) =>
  fetch(`${current.url}/api/setup`, {
    method: "PATCH",
    headers: { ...current.headers, "content-type": "application/json" },
    body: JSON.stringify({ completed: true, connectedProviders: ["claude-code"] }),
  });

/** A second browser asks to pair and the hub's window allows it, as on another device. */
const allowAnotherDevice = async (current: Hub, name: string) => {
  const opened = await fetch(`${current.url}/api/pairing`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, platform: "iOS", kind: "browser" }),
  });
  const { status } = (await opened.json()) as { readonly status: { readonly id: string } };
  const allowed = await fetch(`${current.url}/api/pairing/requests/${status.id}/allow`, {
    method: "POST",
    headers: current.headers,
  });
  expect(allowed.ok).toBe(true);
};

test("Settings lists the allowed devices, and Remove asks first and signs one out", async ({ page }) => {
  hub = await startHub(dataDir);
  const current = hub;
  await finishSetup(current);
  await allowAnotherDevice(current, "Safari on iPhone");

  await page.goto(`${current.url}/#/settings/devices`);
  const allowed = page.getByRole("list", { name: "Allowed devices" });
  await expect(allowed.getByRole("listitem")).toHaveCount(3);
  const window = allowed.getByRole("listitem").filter({ hasText: "This computer's Hobbots window" });
  await expect(window).toContainText("The hub · hobs work here");
  await expect(window.getByRole("button")).toHaveCount(0);
  const phone = allowed.getByRole("listitem").filter({ hasText: "Safari on iPhone" });
  await expect(phone).toContainText("A browser · iOS · on this computer · allowed");

  // Remove asks first; Keep takes the question back.
  await phone.getByRole("button", { name: "Remove Safari on iPhone" }).click();
  await expect(phone.getByText("Remove Safari on iPhone? It is signed out now and has to ask again.")).toBeVisible();
  await phone.getByRole("button", { name: "Keep" }).click();
  await expect(phone.getByRole("button", { name: "Remove Safari on iPhone" })).toBeFocused();

  await phone.getByRole("button", { name: "Remove Safari on iPhone" }).click();
  await phone.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(allowed.getByRole("listitem")).toHaveCount(2);
  await expect(allowed.getByText("Safari on iPhone")).toHaveCount(0);

  const listed = (await (
    await fetch(`${current.url}/api/devices`, { headers: current.headers })
  ).json()) as ReadonlyArray<{
    readonly name: string;
    readonly revokedAt: string | null;
  }>;
  expect(listed.find((device) => device.name === "Safari on iPhone")?.revokedAt).not.toBeNull();

  // A device allowed elsewhere shows up without a reload.
  await allowAnotherDevice(current, "Firefox on Linux");
  await expect(allowed.getByRole("listitem").filter({ hasText: "Firefox on Linux" })).toBeVisible();
});
