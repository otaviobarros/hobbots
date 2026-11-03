import type { Page } from "@playwright/test";
import { emptyDataDir, expect, type Hub, removeDataDir, startHub, test } from "./hub.ts";

// Setup's local pages (ADR 025, #446), as the desktop app shows them on a computer that is not a hub
// yet. The hub here only serves the web client's build; the app's setup bridge is scripted in the
// page, since the main process checks the address, pairs and keeps the token (its own tests prove
// that against fake hubs).

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

/** The desktop app's setup bridge: two hubs found, a local address refused, and the hub's answer up to the test. */
const scriptBridge = () => {
  const listeners = new Set<(waiting: unknown) => void>();
  let settle: ((end: unknown) => void) | undefined;
  const calls: Array<string> = [];
  const record = { calls, ranHere: false, cancels: 0 };
  Object.assign(window, {
    connectCalls: record,
    answerConnect: (end: unknown) => settle?.(end),
    hobbots: {
      setup: {
        runHere: async () => {
          record.ranHere = true;
          // The hub's own window takes over once it has started.
          await new Promise(() => {});
        },
        findHubs: async () => ({
          kind: "hubs",
          hubs: [
            {
              computer: "attic",
              address: "http://attic.example.ts.net:4317",
              hubName: null,
              version: "0.1.0",
              support: "hubOlder",
            },
            {
              computer: "studio",
              address: "http://studio.example.ts.net:4317",
              hubName: "Studio",
              version: "0.5.0",
              support: "supported",
            },
          ],
        }),
        connect: (address: string) => {
          calls.push(address);
          if (address === "192.168.1.20") {
            return Promise.resolve({ kind: "refused", refusal: { reason: "LocalNetwork" } });
          }
          return new Promise((resolve) => {
            settle = resolve;
            // A hub that takes its time: no code yet, and only the test answers.
            if (address === "slow") return;
            const waiting = {
              computer: "studio",
              owner: "you@example.com",
              hubName: "Studio",
              code: "042317",
              expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
            };
            setTimeout(() => {
              for (const listener of listeners) listener(waiting);
            }, 50);
          });
        },
        cancel: async () => {
          record.cancels++;
          // The slow hub's answer is left to the test, to show an answer after Back changes nothing.
          if (calls.at(-1) !== "slow") settle?.({ kind: "cancelled" });
        },
        onWaiting: (listener: (waiting: unknown) => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
    },
  });
};

/** Opens setup's local pages from the hub's build, with the scripted bridge. */
const openSetup = async (page: Page) => {
  hub = await startHub(dataDir);
  await page.addInitScript(scriptBridge);
  await page.goto(`${hub.url}/local.html`);
};

const answer = (page: Page, end: unknown) =>
  page.evaluate((value) => (window as unknown as { answerConnect: (end: unknown) => void }).answerConnect(value), end);

const studio = { computer: "studio", address: "http://studio.example.ts.net:4317" };

// covers DP-001, DP-002
test("[TC-DP-204] Connect lists the hubs found, refuses a local address, waits with the code, and Deny then Allow each show", async ({
  page,
}) => {
  await openSetup(page);
  await page.getByRole("button", { name: "Get started" }).click();
  await expect(page.getByRole("heading", { name: "Where should Hobbots run?" })).toBeVisible();
  await expect(page.getByText(/Coming soon/)).toHaveCount(0);
  await page.getByRole("button", { name: /Connect to Hobbots on another computer/ }).click();

  await expect(page.getByRole("heading", { name: "Connect to your hub" })).toBeVisible();
  // A hub this app cannot use is listed with why, and offers no Connect.
  await expect(page.getByText("attic runs an older Hobbots. Update it there to connect.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Connect to attic" })).toHaveCount(0);
  await expect(
    page.getByText(/http:\/\/studio\.example\.ts\.net:4317 · Hobbots 0\.5\.0 · calls itself “Studio”/),
  ).toBeVisible();

  // Connect waits for an address; a local network address is refused with the reason.
  await expect(page.getByRole("button", { name: "Connect", exact: true })).toBeDisabled();
  await page.getByLabel("Address").fill("192.168.1.20");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "Hobbots connects through Tailscale only. Type the hub's Tailscale name instead of a local address.",
  );

  // Picking the hub found waits with the code its prompt shows, naming the computer as Tailscale does.
  await page.getByRole("button", { name: "Connect to studio" }).click();
  await expect(page.getByRole("heading", { name: "Waiting for studio to let you in" })).toBeVisible();
  await expect(page.getByText("042 317")).toBeVisible();
  await expect(
    page.getByText("studio on your tailnet, signed in as you@example.com · calls itself “Studio”"),
  ).toBeVisible();

  await answer(page, { kind: "ended", ...studio, outcome: { kind: "denied" } });
  await expect(page.getByRole("heading", { name: "studio said no" })).toBeVisible();
  await page.getByRole("button", { name: "Ask again" }).click();
  await expect(page.getByText("042 317")).toBeVisible();
  await answer(page, { kind: "allowed", computer: "studio" });
  await expect(page.getByRole("heading", { name: "You're in!" })).toBeVisible();

  const calls = await page.evaluate(
    () => (window as unknown as { connectCalls: { calls: Array<string> } }).connectCalls.calls,
  );
  expect(calls).toEqual(["192.168.1.20", studio.address, studio.address]);
});

// covers DP-001, DP-002
test("[TC-DP-205] an expired request or an unreachable hub says why, Cancel keeps the address, and Run here starts the hub", async ({
  page,
}) => {
  await openSetup(page);
  // Someone who already uses Hobbots has a hub elsewhere, so Welcome's second way in is Connect.
  await page.getByRole("button", { name: "I already use Hobbots" }).click();
  await page.getByLabel("Address").fill("studio");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByText("042 317")).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByLabel("Address")).toHaveValue("studio");

  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByText("042 317")).toBeVisible();
  await answer(page, { kind: "ended", ...studio, outcome: { kind: "expired" } });
  await expect(page.getByRole("heading", { name: "This request ran out of time" })).toBeVisible();
  await page.getByRole("button", { name: "Ask again" }).click();
  await answer(page, { kind: "ended", ...studio, outcome: { kind: "noAnswer" } });
  await expect(page.getByRole("heading", { name: "Hobbots on studio isn't answering" })).toBeVisible();
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.getByLabel("Address")).toHaveValue("studio");

  await page.getByRole("button", { name: "Back" }).click();
  await page.getByRole("button", { name: /Run Hobbots on this computer/ }).click();
  await expect(page.getByText("Starting Hobbots…")).toBeVisible();
  await expect(page.getByRole("button", { name: /Connect to Hobbots on another computer/ })).toBeDisabled();
  expect(
    await page.evaluate(() => (window as unknown as { connectCalls: { ranHere: boolean } }).connectCalls.ranHere),
  ).toBe(true);
});

// covers DP-001
test("[TC-DP-207] Back while connecting stops the request, and an answer that comes after changes nothing", async ({
  page,
}) => {
  await openSetup(page);
  await page.getByRole("button", { name: "I already use Hobbots" }).click();
  await page.getByLabel("Address").fill("slow");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByRole("button", { name: "Connecting…" })).toBeDisabled();
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.getByRole("button", { name: /Run Hobbots on this computer/ })).toBeEnabled();
  expect(
    await page.evaluate(() => (window as unknown as { connectCalls: { cancels: number } }).connectCalls.cancels),
  ).toBe(1);
  // The hub allows the request it no longer has a page for: Where Hobbots runs stays.
  await answer(page, { kind: "allowed", computer: "slow" });
  await expect(page.getByRole("button", { name: /Run Hobbots on this computer/ })).toBeEnabled();
  await expect(page.getByRole("heading", { name: "You're in!" })).toHaveCount(0);
});
