import type { Page } from "@playwright/test";
import { emptyDataDir, expect, type Hub, removeDataDir, startHub, test } from "./hub.ts";

// The hub's pages inside a connected desktop's window (ADR 025, #448), against a hub from source.
// The desktop app's bridge is stood in for by a script that the test drives: its main process is
// checked by the desktop app's own suites.

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

const call = async <A>(current: Hub, method: string, path: string, body?: unknown): Promise<A> => {
  const response = await fetch(`${current.url}/api${path}`, {
    method,
    headers: { ...current.headers, ...(body !== undefined && { "content-type": "application/json" }) },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${method} ${path} answered ${response.status}: ${await response.text()}`);
  const text = await response.text();
  return (text === "" ? undefined : JSON.parse(text)) as A;
};

const ADDRESS = "http://studio.example.ts.net:4317";

/** The views the app's main process sends, in its own words. */
const VIEWS = {
  connected: { state: "connected", title: "Connected to studio", detail: ADDRESS, actions: [] },
  unreachable: {
    state: "unreachable",
    title: "Hobbots on studio isn't answering.",
    detail: "It may be closed, remote access may be paused or off, or its port changed. Hobbots tries again.",
    actions: ["tryAgain", "changeAddress"],
  },
  tailscaleOff: {
    state: "tailscaleOff",
    title: "Tailscale is off on this Mac.",
    detail: "Open Tailscale and turn it on. Hobbots reconnects by itself.",
    actions: ["openTailscale", "tryAgain"],
  },
} as const;

/**
 * A connected desktop's bridge, as the preload script exposes it: the test sets the view, and the
 * page's calls are recorded. A typed address on another computer is refused, as the app does.
 */
const standInBridge = (page: Page) =>
  page.addInitScript(
    ({ address }) => {
      const listeners = new Set<(view: unknown) => void>();
      const calls: Array<string> = [];
      let view: Record<string, unknown> = {
        hubName: "Studio",
        nodeName: "studio.example.ts.net",
        address,
        appVersion: "0.5.0",
        hubVersion: "0.5.0",
        state: "connected",
        title: "Connected to studio",
        detail: address,
        actions: [],
      };
      const testing = globalThis as unknown as Record<string, unknown>;
      testing.__connection = {
        calls,
        set: (next: Record<string, unknown>) => {
          // A view from an app from before the reasons has no title, detail or actions at all.
          const { older, ...rest } = next;
          view = { ...view, ...rest };
          if (older === true) {
            delete view.title;
            delete view.detail;
            delete view.actions;
          }
          for (const listener of listeners) listener(view);
        },
      };
      testing.hobbots = {
        connection: {
          get: async () => view,
          retry: async () => {
            calls.push("retry");
            return view;
          },
          openTailscale: async () => {
            calls.push("openTailscale");
            return true;
          },
          changeAddress: async (typed: string) => {
            calls.push(`changeAddress ${typed}`);
            // A slow answer, held until the test releases it, as when the hub takes its time to answer.
            if (typed.startsWith("slow")) await new Promise((release) => (testing.__release = release));
            return typed.startsWith("other")
              ? {
                  ok: false,
                  message: "other.example.ts.net is a different computer. To use the hub there, disconnect first.",
                }
              : { ok: true };
          },
          onChange: (listener: (next: unknown) => void) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
        },
      };
    },
    { address: ADDRESS },
  );

const setView = (page: Page, view: (typeof VIEWS)[keyof typeof VIEWS]) =>
  page.evaluate(
    (next) => (globalThis as unknown as { __connection: { set: (v: unknown) => void } }).__connection.set(next),
    view,
  );

const bridgeCalls = (page: Page) =>
  page.evaluate(() => (globalThis as unknown as { __connection: { calls: Array<string> } }).__connection.calls);

const banner = (page: Page) => page.getByRole("status").filter({ hasText: /isn't answering|Tailscale is off/ });

/** A finished setup and Lark the hob, open in a connected desktop's window with a message typed but not sent. */
const openHub = async (page: Page) => {
  const current = await startHub(dataDir);
  hub = current;
  await call(current, "PATCH", "/setup", { completed: true, connectedProviders: ["claude-code"] });
  const lark = await call<{ id: string }>(current, "POST", "/agents", {
    name: "Lark",
    role: null,
    roleTitle: "Courier",
    sigil: "assistant",
    hat: null,
    tool: null,
    lookSeed: 2604,
    lookColor: "moss",
    runtime: "claude-code",
    model: "fake-thinker",
    effort: "medium",
    instructions: "",
  });
  await standInBridge(page);
  await page.goto(`${current.url}/#/hobs/${lark.id}/new`);
  const composer = page.getByRole("textbox", { name: /^Message Lark/ });
  await composer.fill("sent once the hub is back");
  return { composer };
};

// covers DP-001, DP-002
test("[TC-DP-170] a hub that stops shows the app's reason in the banner, and the page carries on when it starts again", async ({
  page,
}) => {
  const { composer } = await openHub(page);
  await expect(banner(page)).toBeHidden();

  await hub?.stop();
  hub = undefined;
  await setView(page, VIEWS.unreachable);
  await expect(banner(page)).toContainText("Hobbots on studio isn't answering.");
  await expect(banner(page)).toContainText("its port changed");
  // The app's reason takes the place of the generic one a browser shows.
  await expect(page.getByText("Reconnecting to Hobbots")).toBeHidden();
  await banner(page).getByRole("button", { name: "Try now" }).click();
  expect(await bridgeCalls(page)).toEqual(["retry"]);
  await page.screenshot({ path: test.info().outputPath("hub-not-answering.png") });

  // The hub starts again on the same data folder: the page reconnects with the same device.
  hub = await startHub(dataDir);
  await setView(page, VIEWS.connected);
  await expect(banner(page)).toBeHidden();
  await expect(composer).toHaveValue("sent once the hub is back");
  await composer.press("Enter");
  await expect(page.getByText("Echo: sent once the hub is back", { exact: true })).toBeVisible();
});

// covers DP-001
test("[TC-DP-171] Change address takes the hub's new address in the banner, and says why one is refused", async ({
  page,
}) => {
  await openHub(page);
  await setView(page, VIEWS.unreachable);
  await banner(page).getByRole("button", { name: "Change address" }).click();
  const field = banner(page).getByRole("textbox", { name: "Hub address" });
  await expect(field).toHaveValue(ADDRESS);

  await field.fill("other:4400");
  await banner(page).getByRole("button", { name: "Connect" }).click();
  await expect(banner(page).getByRole("alert")).toHaveText(
    "other.example.ts.net is a different computer. To use the hub there, disconnect first.",
  );
  await expect(field).toHaveAttribute("aria-invalid", "true");
  await page.screenshot({ path: test.info().outputPath("change-address-refused.png") });

  await field.fill("studio:4400");
  await banner(page).getByRole("button", { name: "Connect" }).click();
  await expect(field).toBeHidden();
  expect(await bridgeCalls(page)).toEqual(["changeAddress other:4400", "changeAddress studio:4400"]);
});

// covers DP-001
test("[TC-DP-171] an address being checked stays locked until the app answers, so no second change starts", async ({
  page,
}) => {
  await openHub(page);
  await setView(page, VIEWS.unreachable);
  await banner(page).getByRole("button", { name: "Change address" }).click();
  const field = banner(page).getByRole("textbox", { name: "Hub address" });
  await field.fill("slow:4400");
  await banner(page).getByRole("button", { name: "Connect" }).click();
  const checking = banner(page).getByRole("button", { name: "Checking…" });
  await expect(checking).toBeDisabled();
  await expect(field).toHaveAttribute("readonly", "");

  // Typing while it waits changes nothing, and the change stays pending.
  await field.press("End");
  await field.pressSequentially("9");
  await expect(field).toHaveValue("slow:4400");
  await expect(checking).toBeDisabled();

  // The app answers: the form closes on that answer, and only one change was ever asked.
  await page.evaluate(() => (globalThis as unknown as { __release: (v?: unknown) => void }).__release());
  await expect(field).toBeHidden();
  expect(await bridgeCalls(page)).toEqual(["changeAddress slow:4400"]);
});

// covers DP-001
test("[TC-DP-169] Tailscale off on this Mac offers to open Tailscale", async ({ page }) => {
  await openHub(page);
  await setView(page, VIEWS.tailscaleOff);
  await expect(banner(page)).toContainText("Tailscale is off on this Mac.");
  await expect(banner(page).getByRole("button", { name: "Change address" })).toBeHidden();
  await banner(page).getByRole("button", { name: "Open Tailscale" }).click();
  expect(await bridgeCalls(page)).toEqual(["openTailscale"]);
  await page.screenshot({ path: test.info().outputPath("tailscale-off.png") });
});

// covers DP-001
test("[TC-DP-169] a bridge from before the reasons keeps the generic banner instead of breaking the page", async ({
  page,
}) => {
  const { composer } = await openHub(page);
  const errors: Array<string> = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.evaluate(() =>
    (globalThis as unknown as { __connection: { set: (v: unknown) => void } }).__connection.set({
      state: "unreachable",
      older: true,
    }),
  );
  await hub?.stop();
  hub = undefined;
  await expect(
    page.getByRole("status").filter({ hasText: /Reconnecting to Hobbots|Hobbots cannot reach/ }),
  ).toBeVisible();
  await expect(banner(page)).toBeHidden();
  await expect(composer).toHaveValue("sent once the hub is back");
  expect(errors).toEqual([]);
});
