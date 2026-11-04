import type { Locator, Page } from "@playwright/test";
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

const api = async <A>(current: Hub, method: string, path: string, body?: unknown): Promise<A> => {
  const response = await fetch(`${current.url}${path}`, {
    method,
    headers: { ...current.headers, ...(body !== undefined && { "content-type": "application/json" }) },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${method} ${path} answered ${response.status}: ${await response.text()}`);
  return (await response.json()) as A;
};

/** A hub past onboarding with one hob, Pip, and one chat with it. */
const hubWithPipAndAChat = async () => {
  const current = await startHub(dataDir);
  await api(current, "PATCH", "/api/setup", { completed: true, connectedProviders: ["claude-code"] });
  const pip = await api<{ readonly id: string }>(current, "POST", "/api/agents", {
    name: "Pip",
    role: "writer",
    roleTitle: "Writer",
    sigil: "writer",
    hat: "pointed",
    tool: "quill",
    lookSeed: 4821,
    lookColor: "violet",
    runtime: "claude-code",
    model: null,
    effort: null,
    instructions: "Write short answers.",
  });
  await api(current, "POST", `/api/agents/${pip.id}/threads`, {});
  return { current, pip };
};

/** Holds every GET to `url` until `release` is called, as a slow hub over Tailscale would. */
const holdReads = async (page: Page, url: string) => {
  let release = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(url, async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    await released;
    await route.fallback();
  });
  return release;
};

const box = async (locator: Locator) => {
  const found = await locator.boundingBox();
  if (found === null) throw new Error("The element is not on screen");
  return found;
};

// covers UX-001
test("[TC-UX-092] a hob's page holds its header still while its chats are read", async ({ page }) => {
  const { current, pip } = await hubWithPipAndAChat();
  hub = current;
  const release = await holdReads(page, `${current.url}/api/agents/${pip.id}/threads*`);
  await page.goto(`${current.url}/#/hobs/${pip.id}`);

  // The header stands at once, with the hob's name, and the chats are skeleton rows, not a line.
  const hero = page.getByRole("region", { name: "Pip", exact: true });
  await expect(hero.getByRole("heading", { name: "Pip" })).toBeVisible();
  const chats = page.getByRole("tabpanel", { name: /Chats/ });
  await expect(chats.locator("[aria-busy=true]")).toBeVisible();
  await expect(page.getByText(/Loading|Reading/)).toHaveCount(0);
  const before = await box(hero);

  release();
  await expect(chats.getByRole("listitem")).toHaveCount(1);
  await expect(chats.locator("[aria-busy=true]")).toHaveCount(0);
  expect(await box(hero)).toEqual(before);
});

// covers UX-001
test("[TC-UX-092] the Inbox holds its header still while its rows are read", async ({ page }) => {
  const { current } = await hubWithPipAndAChat();
  hub = current;
  const release = await holdReads(page, `${current.url}/api/approvals`);
  await page.goto(`${current.url}/#/inbox?tab=history`);

  const title = page.getByRole("heading", { name: "Inbox", level: 1 });
  await expect(title).toBeVisible();
  const decisions = page.getByRole("region", { name: "Decision history" });
  await expect(decisions.locator("[aria-busy=true]")).toBeVisible();
  await expect(page.getByText(/Loading|Reading/)).toHaveCount(0);
  const before = await box(title);

  release();
  await expect(decisions.locator("[aria-busy=true]")).toHaveCount(0);
  expect(await box(title)).toEqual(before);
});

// covers UX-001
test("[TC-UX-183] the window paints its frame in this device's theme before the app's code loads, and the app takes its place", async ({
  page,
}) => {
  const { current } = await hubWithPipAndAChat();
  hub = current;
  await page.addInitScript(() => {
    localStorage.setItem("hobbots.theme", JSON.stringify("lamplight-paper"));
    localStorage.setItem("sidebar.open", "true");
  });
  // The app's code waits, as on a slow first load.
  const release = await holdReads(page, "**/assets/main-*.js");
  // The page never finishes loading while its code waits, so the test goes on once it arrives.
  await page.goto(`${current.url}/`, { waitUntil: "commit" });

  const frame = page.locator("#root > [aria-busy=true]");
  await expect(frame).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "lamplight-paper");
  const framed = await box(frame.locator("> div > div").first());
  expect(framed.width).toBe(256);

  release();
  const sidebar = page.getByRole("navigation", { name: "Sections" });
  await expect(sidebar).toBeVisible();
  await expect(frame).toHaveCount(0);
  expect((await box(sidebar)).width).toBe(framed.width);
});
