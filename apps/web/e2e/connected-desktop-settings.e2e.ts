import { emptyDataDir, expect, type Hub, removeDataDir, startHub, test } from "./hub.ts";

// Settings › Devices as a connected desktop's window shows it (ADR 025): the hub's own pages, with
// the desktop app's bridge stood in. Disconnect itself runs in the desktop app's main process,
// proven in apps/desktop/test/connected-desktop.test.ts.

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

const setupDone = (current: Hub) =>
  fetch(`${current.url}/api/setup`, {
    method: "PATCH",
    headers: { ...current.headers, "content-type": "application/json" },
    body: JSON.stringify({ completed: true, connectedProviders: ["claude-code"] }),
  });

/** The test browser's own device on the hub, which stands in for the connected Mac's. */
const browserDevice = async (current: Hub) => {
  const listed = await fetch(`${current.url}/api/devices`, { headers: current.headers });
  const devices = (await listed.json()) as ReadonlyArray<{ readonly id: string; readonly name: string }>;
  return devices.find((device) => device.name === "Playwright")?.id ?? "";
};

/** The connected desktop's bridge: the hub it uses, and Disconnect, which records each call. */
const asConnectedDesktop = (deviceId: string) => {
  const calls: Array<string> = [];
  (window as unknown as Record<string, unknown>).disconnectCalls = calls;
  (window as unknown as Record<string, unknown>).hobbots = {
    onOpenRequest: () => () => undefined,
    connection: {
      get: async () => ({
        hubName: "Studio",
        nodeName: "studio-desk.example.ts.net",
        address: "http://studio-desk.example.ts.net:4317",
        deviceId,
        appVersion: "0.5.1",
        hubVersion: "0.5.0",
        state: "connected",
      }),
      // The app starts again once this answers, so the page never hears back in practice.
      disconnect: () => {
        calls.push("disconnect");
        return new Promise(() => undefined);
      },
    },
  };
};

// covers DP-001
test("[TC-DP-217] a connected desktop's Settings › Devices shows its hub in place of remote access, and Disconnect asks first", async ({
  page,
}) => {
  hub = await startHub(dataDir);
  const current = hub;
  await setupDone(current);
  await page.addInitScript(asConnectedDesktop, await browserDevice(current));
  await page.goto(`${current.url}/#/settings`);
  const devices = page.getByRole("region", { name: "Devices" });

  // The hub it uses, its address and both versions; nothing that changes the hub's network.
  await expect(devices.getByRole("status").filter({ hasText: "Connected to Studio" })).toBeVisible();
  await expect(devices.getByText("http://studio-desk.example.ts.net:4317 · over Tailscale")).toBeVisible();
  await expect(devices.getByText("Hobbots 0.5.0 on Studio · 0.5.1 on this Mac")).toBeVisible();
  await expect(devices.getByRole("switch", { name: "Use Hobbots from my other devices" })).toHaveCount(0);
  await expect(devices.getByText("Use HTTPS through Tailscale")).toHaveCount(0);
  await expect(devices.getByLabel("Port")).toHaveCount(0);

  // The allowed devices stay: the hub's window by the hub's name, and this Mac marked, with no Revoke.
  const allowed = devices.getByRole("list", { name: "Allowed devices" });
  await expect(allowed.getByText("The Hobbots window on Studio")).toBeVisible();
  const own = allowed.locator("li").filter({ hasText: "this Mac ·" });
  await expect(own).toHaveCount(1);
  await expect(own.getByRole("button")).toHaveCount(0);

  // Disconnect… asks in place; Escape takes it back with focus on Disconnect….
  const ask = devices.getByRole("button", { name: "Disconnect from Studio" });
  await ask.click();
  const question = devices.getByRole("group", { name: "Disconnect this Mac from Studio?" });
  await expect(question).toContainText("Your hobs, chats and files stay on Studio.");
  await expect(question.getByRole("button", { name: "Keep" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(question).toBeHidden();
  await expect(ask).toBeFocused();
  expect(await page.evaluate(() => (window as unknown as { disconnectCalls: Array<string> }).disconnectCalls)).toEqual(
    [],
  );

  // Disconnect asks the desktop app once, and waits for it to start again.
  await ask.click();
  await question.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(question.getByRole("button", { name: "Disconnecting…" })).toBeDisabled();
  expect(await page.evaluate(() => (window as unknown as { disconnectCalls: Array<string> }).disconnectCalls)).toEqual([
    "disconnect",
  ]);
});
