import { writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import type { Page } from "@playwright/test";
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

/** What the fake Tailscale reports from now on: the hub reads the file on every check. */
const fakeTailscale = (state: "running" | "notInstalled" | "signedOut") =>
  writeFileSync(
    join(dataDir, "fake-tailscale.json"),
    JSON.stringify(
      state === "running"
        ? {
            state,
            dnsName: "hub.example.ts.net",
            addresses: ["127.0.0.2"],
            peers: {
              "127.0.0.1": {
                nodeId: "nFAKEHUB",
                nodeName: "hub.example.ts.net",
                owner: { _tag: "User", login: "you@example.com" },
              },
            },
            ranges: ["127.0.0.0/8"],
          }
        : { state, dnsName: null, addresses: [], peers: {}, ranges: ["127.0.0.0/8"] },
    ),
  );

const remoteAccess = async (current: Hub) =>
  (await (await fetch(`${current.url}/api/remote-access`, { headers: current.headers })).json()) as {
    readonly enabled: boolean;
    readonly port: number;
  };

const otherDevices = "Use Hobbots on your phone too?";

/** Walks a new installation to the step that asks about other devices, which comes after Folders. */
const openRemoteStep = async (page: Page, current: Hub) => {
  await page.goto(`${current.url}/#/welcome`);
  await page.getByRole("link", { name: "Get started" }).click();
  await page.getByRole("link", { name: /Run Hobbots on this computer/ }).click();
  await page.getByRole("button", { name: "Connect Claude" }).click();
  await expect(page.getByText("✓ Connected")).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("textbox", { name: "Name", exact: true }).fill("Pip");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "How careful should your hobs be?" })).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Where can hobs work?" })).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: otherDevices })).toBeVisible();
};

/** Other devices goes on to the last step of setup. */
const atReady = (page: Page) => expect(page.getByRole("heading", { name: "Everything is ready" })).toBeVisible();

// covers DP-001, DP-004
test("[TC-DP-123] setup turns remote access on and shows the address and its QR code", async ({ page }) => {
  test.skip(!(await spareLoopback()), "needs 127.0.0.2 on loopback");
  fakeTailscale("running");
  hub = await startHub(dataDir, { HOBBOTS_FAKE_TAILSCALE: "on" });
  const port = Number(new URL(hub.url).port);
  await openRemoteStep(page, hub);

  await expect(page.getByText("Tailscale is connected")).toBeVisible();
  await expect(page.getByText("This computer is hub on your tailnet")).toBeVisible();
  const remote = page.getByRole("switch", { name: "Let my other devices connect" });
  await expect(remote).not.toBeChecked();
  await expect(page.getByText("You can turn this on later")).toBeVisible();

  await remote.click();
  await expect(remote).toBeChecked();
  const address = `http://hub.example.ts.net:${port}`;
  await expect(page.getByText(address, { exact: true })).toBeVisible();
  await expect(page.getByRole("img", { name: `QR code for ${address}` })).toBeVisible();
  await expect(page.getByText("Other devices can connect after you allow them")).toBeVisible();
  expect((await remoteAccess(hub)).enabled).toBe(true);

  await page.getByRole("link", { name: "Continue" }).click();
  await atReady(page);
  expect((await remoteAccess(hub)).enabled).toBe(true);
});

// covers DP-001, DP-004
test("[TC-DP-124] setup without Tailscale shows how to get it, notices it, and Skip leaves remote access off", async ({
  page,
}) => {
  fakeTailscale("notInstalled");
  hub = await startHub(dataDir, { HOBBOTS_FAKE_TAILSCALE: "on" });
  await openRemoteStep(page, hub);

  const missing = page.getByRole("region", { name: "Tailscale isn't on this computer yet" });
  await expect(missing).toBeVisible();
  await expect(missing.getByRole("link", { name: "Get Tailscale" })).toHaveAttribute(
    "href",
    "https://tailscale.com/download",
  );
  await expect(page.getByRole("switch", { name: "Let my other devices connect" })).toHaveCount(0);

  // Signed out reads differently; Check again asks the hub at once.
  fakeTailscale("signedOut");
  await missing.getByRole("button", { name: "Check again" }).click();
  await expect(page.getByRole("region", { name: "Tailscale is signed out on this computer" })).toBeVisible();

  // Once Tailscale runs, the step notices by itself and offers the switch.
  fakeTailscale("running");
  await expect(page.getByText("Tailscale is connected")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("switch", { name: "Let my other devices connect" })).not.toBeChecked();

  await page.getByRole("button", { name: "Skip for now" }).click();
  await atReady(page);
  expect((await remoteAccess(hub)).enabled).toBe(false);
});

// covers DP-001, DP-004
test("[TC-DP-127] Skip turns remote access off before leaving setup, and stays when the hub refuses", async ({
  page,
}) => {
  test.skip(!(await spareLoopback()), "needs 127.0.0.2 on loopback");
  fakeTailscale("running");
  hub = await startHub(dataDir, { HOBBOTS_FAKE_TAILSCALE: "on" });
  const current = hub;
  await openRemoteStep(page, current);
  await page.getByRole("switch", { name: "Let my other devices connect" }).click();
  await expect(page.getByRole("img", { name: /^QR code for / })).toBeVisible();

  // The hub cannot turn it off: setup stays on this step and says so.
  await page.route("**/api/remote-access", (route) =>
    route.request().method() === "PATCH" ? route.fulfill({ status: 500, body: "{}" }) : route.fallback(),
  );
  await page.getByRole("button", { name: "Skip for now" }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "Hobbots could not read or change remote access. Try again in a moment.",
  );
  await expect(page.getByRole("heading", { name: otherDevices })).toBeVisible();
  expect((await remoteAccess(current)).enabled).toBe(true);

  // Once the hub answers, Skip turns it off and only then moves on.
  await page.unroute("**/api/remote-access");
  await page.getByRole("button", { name: "Skip for now" }).click();
  await atReady(page);
  expect((await remoteAccess(current)).enabled).toBe(false);
});
