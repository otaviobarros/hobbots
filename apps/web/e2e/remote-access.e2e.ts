import { writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
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

// The fake tailnet serves on 127.0.0.2, which Linux routes to loopback; macOS needs an alias first.
const spareLoopback = () =>
  new Promise<boolean>((done) => {
    const probe = createServer();
    probe.once("error", () => done(false));
    probe.listen({ host: "127.0.0.2", port: 0 }, () => probe.close(() => done(true)));
  });

/**
 * What the hub answers on its fake tailnet address, as another device on the tailnet would reach
 * it, or the error code of a connection it refuses.
 */
const onTailnet = (port: number) =>
  fetch(`http://127.0.0.2:${port}/api/agents`, { signal: AbortSignal.timeout(1000) }).then(
    async (response) => ({ status: response.status, tag: ((await response.json()) as { _tag?: unknown })._tag }),
    (error: Error & { cause?: { code?: string } }) => error.cause?.code ?? error.name,
  );

/** A tailnet device that has not paired is refused like any other (ADR 021). */
const notPaired = { status: 401, tag: "DeviceRequired" };

// covers DP-004
test("[TC-DP-072] turns remote access on in Settings, and says why once Tailscale turns off", async ({ page }) => {
  test.skip(!(await spareLoopback()), "needs 127.0.0.2 on loopback");
  hub = await startHub(dataDir, { HOBBOTS_FAKE_TAILSCALE: "on" });
  const current = hub;
  const port = Number(new URL(current.url).port);
  await fetch(`${current.url}/api/setup`, {
    method: "PATCH",
    headers: { ...current.headers, "content-type": "application/json" },
    body: JSON.stringify({ completed: true, connectedProviders: ["claude-code"] }),
  });

  // Off by default: only this computer reaches the hub.
  await page.goto(`${current.url}/#/settings`);
  const devices = page.getByRole("region", { name: "Devices" });
  const remote = devices.getByRole("switch", { name: "Use Hobbots from my other devices" });
  await expect(remote).not.toBeChecked();
  await expect(devices.getByText("Only this computer can reach Hobbots right now.")).toBeVisible();
  expect(await onTailnet(port)).toBe("ECONNREFUSED");

  await remote.click();
  await expect(remote).toBeChecked();
  await expect(devices.getByRole("status")).toHaveText("Tailscale connected · this computer is hub");
  await expect(devices.getByText(`http://hub.example.ts.net:${port}`)).toBeVisible();
  expect(await onTailnet(port)).toEqual(notPaired);

  // Tailscale turns off on the hub: within its next check the hub leaves the tailnet and says why.
  writeFileSync(
    join(dataDir, "fake-tailscale.json"),
    JSON.stringify({ state: "notRunning", dnsName: null, addresses: [], peers: {}, ranges: ["127.0.0.0/8"] }),
  );
  await expect(devices.getByRole("status")).toHaveText(
    "Tailscale is off on this computer, so Hobbots stopped listening on your tailnet. Turn Tailscale on and Hobbots listens again within seconds.",
    { timeout: 15_000 },
  );
  expect(await onTailnet(port)).toBe("ECONNREFUSED");
  await expect(remote).toBeChecked();
});
