import { writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { emptyDataDir, expect, type Hub, removeDataDir, startHub, test } from "./hub.ts";

// Interaction check 10 of the screen inventory, end to end in the browser (ADR 021): turn on remote
// access, open the hub's tailnet address in another browser, Allow it on the hub, then Remove it.
// The hub-level proof of the same slice is in apps/server/test/remote-access-end-to-end.test.ts.

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
 * A fake tailnet where the browser's connections, which come from 127.0.0.1, are another of the
 * user's devices rather than the hub itself, as a laptop on the tailnet would be.
 */
const tailnetWithLaptop = {
  state: "running",
  dnsName: "hub.example.ts.net",
  addresses: ["127.0.0.2"],
  self: { nodeId: "nFAKEHUB", nodeName: "hub.example.ts.net", owner: { _tag: "User", login: "you@example.com" } },
  peers: {
    "127.0.0.1": {
      nodeId: "nLAPTOP",
      nodeName: "laptop.example.ts.net",
      owner: { _tag: "User", login: "you@example.com" },
    },
  },
  ranges: ["127.0.0.0/8"],
};

// The hub's own window, as the desktop app's preload names it.
const asDesktop = () => {
  (window as unknown as Record<string, unknown>).hobbots = { onOpenRequest: () => () => undefined };
};

// covers DP-004, PE-006
test("[TC-DP-155] turns on remote access, allows a tailnet browser on the hub, and Remove refuses it at once", async ({
  page,
  browser,
}) => {
  test.skip(!(await spareLoopback()), "needs 127.0.0.2 on loopback");
  writeFileSync(join(dataDir, "fake-tailscale.json"), JSON.stringify(tailnetWithLaptop));
  hub = await startHub(dataDir, { HOBBOTS_FAKE_TAILSCALE: "on" });
  const current = hub;
  const port = Number(new URL(current.url).port);
  await fetch(`${current.url}/api/setup`, {
    method: "PATCH",
    headers: { ...current.headers, "content-type": "application/json" },
    body: JSON.stringify({ completed: true, connectedProviders: ["claude-code"] }),
  });

  // On the hub: turn remote access on in Settings.
  await page.addInitScript(asDesktop);
  await page.goto(`${current.url}/#/settings/devices`);
  const devices = page.getByRole("region", { name: "Devices" });
  const remote = devices.getByRole("switch", { name: "Use Hobbots from my other devices" });
  await remote.click();
  await expect(remote).toBeChecked();
  await expect(devices.getByRole("status")).toHaveText("Tailscale connected · this computer is hub");
  await expect(devices.getByText(`http://hub.example.ts.net:${port}`, { exact: true })).toBeVisible();

  // On the laptop: open the hub's tailnet address, which asks to pair and shows a code.
  const laptop = await browser.newContext();
  const remotePage = await laptop.newPage();
  await remotePage.goto(`http://127.0.0.2:${port}/`);
  await expect(remotePage).toHaveURL(/#\/pair$/);
  await remotePage.getByLabel("Name this device").fill("Kitchen laptop");
  await remotePage.getByRole("button", { name: "Ask for access" }).click();
  await expect(remotePage.getByRole("heading", { name: /^Waiting for approval on / })).toBeVisible();
  const code = (await remotePage.getByText(/^\d{3} \d{3}$/).textContent()) ?? "";
  expect(code).toMatch(/^\d{3} \d{3}$/);

  // On the hub: the prompt names the laptop with the same code, and Allow lets it in.
  const prompt = page.getByRole("dialog", { name: "Kitchen laptop wants to use Hobbots" });
  await expect(prompt).toBeVisible();
  await expect(prompt.getByText(code, { exact: true })).toBeVisible();
  await prompt.getByRole("button", { name: "Allow", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Kitchen laptop can use Hobbots now" })
    .getByRole("button", { name: "Done" })
    .click();

  // The laptop opens Hobbots by itself and stays in after a reload.
  await expect(remotePage).not.toHaveURL(/#\/pair$/, { timeout: 10_000 });
  await expect(remotePage.getByRole("navigation")).toBeVisible();
  await remotePage.reload();
  await expect(remotePage.getByRole("navigation")).toBeVisible();

  // On the hub: Remove the laptop from Settings › Devices.
  const allowed = page.getByRole("list", { name: "Allowed devices" });
  const entry = allowed.getByRole("listitem").filter({ hasText: "Kitchen laptop" });
  await expect(entry).toBeVisible();
  await entry.getByRole("button", { name: "Remove Kitchen laptop" }).click();
  await entry.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(allowed.getByText("Kitchen laptop")).toHaveCount(0);

  // The laptop is refused at once: its open page shows it was removed, and the hub refuses its reads.
  await expect(remotePage.getByRole("heading", { name: "This device was removed from the hub" })).toBeVisible({
    timeout: 5_000,
  });
  const read = await remotePage.request.get(`http://127.0.0.2:${port}/api/agents`);
  expect(read.status()).toBe(401);
  await laptop.close();
});
