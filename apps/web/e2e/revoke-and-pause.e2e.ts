import { createServer } from "node:net";
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

const setupDone = (current: Hub) =>
  fetch(`${current.url}/api/setup`, {
    method: "PATCH",
    headers: { ...current.headers, "content-type": "application/json" },
    body: JSON.stringify({ completed: true, connectedProviders: ["claude-code"] }),
  });

// covers DP-004
test("[TC-DP-099] a browser revoked while it is open sees it was removed, and its cookie is gone", async ({
  page,
  context,
}) => {
  hub = await startHub(dataDir);
  const current = hub;
  await setupDone(current);
  await page.goto(`${current.url}/#/settings`);
  await expect(page.getByRole("region", { name: "Devices" })).toBeVisible();

  // The hub's window revokes the test browser, as Settings › Devices on another device would.
  const listed = await fetch(`${current.url}/api/devices`, { headers: current.headers });
  const devices = (await listed.json()) as ReadonlyArray<{ readonly id: string; readonly name: string }>;
  const browser = devices.find((device) => device.name === "Playwright");
  const revoked = await fetch(`${current.url}/api/devices/${browser?.id}/revoke`, {
    method: "POST",
    headers: current.headers,
  });
  expect(revoked.status).toBe(200);

  // Its stream closes at once, and the hub's answer to it shows the removed screen and drops the cookie.
  await expect(page.getByRole("heading", { name: "This device was removed from the hub" })).toBeVisible({
    timeout: 5_000,
  });
  await expect(page.getByRole("region", { name: "Devices" })).toBeHidden();
  await expect
    .poll(async () => (await context.cookies(current.url)).map((cookie) => cookie.name))
    .not.toContain("hobbots_device");

  // Ask again loads the page afresh, without the old token, so the hub sees a device to pair.
  await page.getByRole("button", { name: "Ask again" }).click();
  await expect(page.getByRole("heading", { name: "This device was removed from the hub" })).toBeHidden();
});

// The fake tailnet serves on 127.0.0.2, which Linux routes to loopback; macOS needs an alias first.
const spareLoopback = () =>
  new Promise<boolean>((done) => {
    const probe = createServer();
    probe.once("error", () => done(false));
    probe.listen({ host: "127.0.0.2", port: 0 }, () => probe.close(() => done(true)));
  });

/** What the hub answers on its fake tailnet address, or the error code of a refused connection. */
const onTailnet = (port: number) =>
  fetch(`http://127.0.0.2:${port}/api/agents`, { signal: AbortSignal.timeout(1000) }).then(
    (response) => response.status,
    (error: Error & { cause?: { code?: string } }) => error.cause?.code ?? error.name,
  );

// covers DP-004
test("[TC-DP-100] Pause remote access leaves the tailnet while this computer keeps working, and Settings resumes it", async ({
  page,
}) => {
  test.skip(!(await spareLoopback()), "needs 127.0.0.2 on loopback");
  hub = await startHub(dataDir, { HOBBOTS_FAKE_TAILSCALE: "on" });
  const current = hub;
  const port = Number(new URL(current.url).port);
  await setupDone(current);
  const change = (payload: Record<string, boolean>) =>
    fetch(`${current.url}/api/remote-access`, {
      method: "PATCH",
      headers: { ...current.headers, "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  await change({ enabled: true });
  expect(await onTailnet(port)).toBe(401);

  await page.goto(`${current.url}/#/settings`);
  const devices = page.getByRole("region", { name: "Devices" });
  await expect(devices.getByRole("status")).toHaveText("Tailscale connected · this computer is hub");

  // The menu-bar icon pauses it, as the hub's window, and every client hears of it.
  await change({ paused: true });
  await expect(devices.getByRole("status")).toHaveText(
    "Remote access is paused from the menu-bar icon, so your other devices cannot reach Hobbots. They stay approved and work again once you resume.",
  );
  expect(await onTailnet(port)).toBe("ECONNREFUSED");
  await expect(devices.getByRole("switch", { name: "Use Hobbots from my other devices" })).toBeChecked();

  await devices.getByRole("button", { name: "Resume remote access" }).click();
  await expect(devices.getByRole("status")).toHaveText("Tailscale connected · this computer is hub");
  expect(await onTailnet(port)).toBe(401);
});
