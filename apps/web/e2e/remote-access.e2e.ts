import { readFileSync, writeFileSync } from "node:fs";
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
  await page.goto(`${current.url}/#/settings/devices`);
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

const finishSetup = (current: Hub) =>
  fetch(`${current.url}/api/setup`, {
    method: "PATCH",
    headers: { ...current.headers, "content-type": "application/json" },
    body: JSON.stringify({ completed: true, connectedProviders: ["claude-code"] }),
  });

// covers DP-002, DP-004
test("[TC-DP-125] Settings shows the address with its QR code, and the port moves the hub and the page", async ({
  page,
}) => {
  test.skip(!(await spareLoopback()), "needs 127.0.0.2 on loopback");
  hub = await startHub(dataDir, { HOBBOTS_FAKE_TAILSCALE: "on" });
  const current = hub;
  const port = Number(new URL(current.url).port);
  await finishSetup(current);

  await page.goto(`${current.url}/#/settings/devices`);
  const devices = page.getByRole("region", { name: "Devices" });
  await devices.getByRole("switch", { name: "Use Hobbots from my other devices" }).click();
  const address = `http://hub.example.ts.net:${port}`;
  await expect(devices.getByText(address, { exact: true })).toBeVisible();
  await expect(devices.getByRole("img", { name: `QR code for ${address}` })).toBeVisible();

  const field = devices.getByRole("textbox", { name: "Port" });
  await expect(field).toHaveValue(String(port));
  await field.fill("80");
  await expect(devices.getByRole("alert")).toHaveText("Pick a port from 1024 to 65535.");
  await expect(devices.getByRole("button", { name: "Change port" })).toHaveCount(0);

  // A new port moves the hub's listeners, and this page, which the hub serves, follows it.
  const moved = port + 200;
  await field.fill(String(moved));
  await devices.getByRole("button", { name: "Change port" }).click();
  await expect(page).toHaveURL(`http://127.0.0.1:${moved}/#/settings/devices`);
  await expect(
    page.getByRole("region", { name: "Devices" }).getByText(`http://hub.example.ts.net:${moved}`, { exact: true }),
  ).toBeVisible();
  expect(await onTailnet(moved)).toEqual(notPaired);
  expect(await onTailnet(port)).toBe("ECONNREFUSED");
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

// covers DP-004
test("[TC-DP-126] Settings lists the allowed devices, and Revoke asks first and signs one out", async ({ page }) => {
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

  // Revoke… asks first; Keep takes the question back.
  await phone.getByRole("button", { name: "Revoke Safari on iPhone" }).click();
  await expect(phone.getByText("Sign Safari on iPhone out now?")).toBeVisible();
  await phone.getByRole("button", { name: "Keep" }).click();
  await expect(phone.getByRole("button", { name: "Revoke Safari on iPhone" })).toBeFocused();

  await phone.getByRole("button", { name: "Revoke Safari on iPhone" }).click();
  await phone.getByRole("button", { name: "Revoke", exact: true }).click();
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

/** What the fake `tailscale serve` forwards to now, as the hub left it in the fake's file. */
const servedTarget = (dir: string): string | undefined => {
  try {
    return (JSON.parse(readFileSync(join(dir, "fake-tailscale.json"), "utf8")) as { serve?: string }).serve;
  } catch {
    return undefined;
  }
};

// covers DP-004
test("[TC-DP-139] turns HTTPS on in Settings, runs tailscale serve after consent, and removes it again", async ({
  page,
}) => {
  test.skip(!(await spareLoopback()), "needs 127.0.0.2 on loopback");
  hub = await startHub(dataDir, { HOBBOTS_FAKE_TAILSCALE: "on" });
  const current = hub;
  const port = Number(new URL(current.url).port);
  const servePort = port + 1000;
  await finishSetup(current);

  await page.goto(`${current.url}/#/settings/devices`);
  const devices = page.getByRole("region", { name: "Devices" });
  await devices.getByRole("switch", { name: "Use Hobbots from my other devices" }).click();
  const https = devices.getByRole("switch", { name: "Use HTTPS through Tailscale" });
  await expect(https).not.toBeChecked();
  await https.click();
  await expect(https).toBeChecked();

  // On, but Tailscale does not serve it yet: the command, which Hobbots runs only after asking.
  await expect(devices.getByText("Tailscale does not serve Hobbots over HTTPS yet.", { exact: false })).toBeVisible();
  await expect(devices.getByText(`tailscale serve --bg http://127.0.0.1:${servePort}`, { exact: true })).toBeVisible();
  await devices.getByRole("button", { name: "Run it for me…" }).click();
  const consent = devices.getByRole("group", { name: /^Hobbots will run tailscale serve --bg/ });
  await expect(consent).toBeVisible();
  await consent.getByRole("button", { name: "Not now" }).click();
  await expect(devices.getByRole("button", { name: "Run it for me…" })).toBeFocused();
  expect(servedTarget(dataDir)).toBeUndefined();

  await devices.getByRole("button", { name: "Run it for me…" }).click();
  await devices.getByRole("button", { name: "Run it", exact: true }).click();
  const address = "https://hub.example.ts.net";
  await expect(devices.getByText(address, { exact: true })).toBeVisible();
  await expect(devices.getByRole("img", { name: `QR code for ${address}` })).toBeVisible();
  await expect(devices.getByText("Tailscale serves Hobbots over HTTPS on your tailnet.")).toBeVisible();
  expect(servedTarget(dataDir)).toBe(`http://127.0.0.1:${servePort}`);

  // Off again: serve still forwards, so Settings offers the command that removes it.
  await https.click();
  await expect(https).not.toBeChecked();
  await expect(devices.getByText(`http://hub.example.ts.net:${port}`, { exact: true })).toBeVisible();
  await expect(devices.getByText("Tailscale still forwards HTTPS to Hobbots.", { exact: false })).toBeVisible();
  const removal = devices.getByText("tailscale serve --https=443 off", { exact: true });
  await expect(removal).toBeVisible();
  await devices.getByRole("button", { name: "Run it for me…" }).click();
  await devices.getByRole("button", { name: "Run it", exact: true }).click();
  await expect(removal).toHaveCount(0);
  expect(servedTarget(dataDir)).toBeUndefined();
});
