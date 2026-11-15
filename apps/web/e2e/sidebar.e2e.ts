import { randomUUID } from "node:crypto";

import type { Page } from "@playwright/test";
import { expectAccessible } from "./accessibility.ts";
import { campAt, emptyDataDir, expect, type Hub, removeDataDir, signInAs, startHub, test, testPeople } from "./hub.ts";

let hub: Hub | undefined;
let dataDir = "";

test.afterEach(async () => {
  await hub?.stop();
  hub = undefined;
  removeDataDir(dataDir);
});

/** A hub past setup with Aldric, who has two threads, Ada, and any `more` hobs named after them. */
const hubWithHobs = async (more: ReadonlyArray<string> = []) => {
  dataDir = emptyDataDir();
  hub = await startHub(dataDir);
  const current = hub;
  const api = async (method: string, path: string, body: unknown = {}) => {
    const response = await fetch(`${current.url}/api${path}`, {
      method,
      headers: { "content-type": "application/json", ...current.headers },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
    return response.json() as Promise<{ readonly id: string }>;
  };
  await api("PATCH", "/setup", { completed: true, connectedProviders: ["claude-code"] });
  const ids: Record<string, string> = {};
  for (const [i, name] of ["Aldric", "Ada", ...more].entries()) {
    const hob = await api("POST", "/agents", {
      id: randomUUID(),
      name,
      role: "assistant",
      roleTitle: "Assistant",
      sigil: "assistant",
      hat: "pointed",
      tool: "none",
      lookSeed: 1000 + i * 337,
      lookColor: "violet",
      runtime: "claude-code",
      model: null,
      effort: null,
      instructions: "",
    });
    ids[name] = hob.id;
  }
  for (const title of ["Plan the spring launch", "Draft the release notes"]) {
    const thread = await api("POST", `/agents/${ids.Aldric}/camps`, {
      key: crypto.randomUUID(),
      title,
      goal: null,
      private: false,
    });
    await api("POST", `/threads/${thread.id}/messages`, { content: title });
  }
  return { url: current.url, ids };
};

const sidebar = (page: Page) => page.getByRole("navigation", { name: "Sections" });

const THEMES = ["lamplight-dusk", "lamplight-paper", "workshop-night", "workshop-daylight"] as const;

/** Where screenshots go when `HOBBOTS_E2E_SHOTS` names a folder, to compare with the design. */
const shot = async (page: Page, name: string) => {
  const folder = process.env.HOBBOTS_E2E_SHOTS;
  if (folder !== undefined) await sidebar(page).screenshot({ path: `${folder}/${name}.png` });
};

/** Puts the app in `theme`, as Settings › This app would. */
const pickTheme = async (page: Page, theme: string) => {
  await page.evaluate((id) => localStorage.setItem("hobbots.theme", JSON.stringify(id)), theme);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
};

const widthOf = async (page: Page) => (await sidebar(page).boundingBox())?.width;

test("the wide sidebar shows Find, the four places, Camps, Direct messages and you, in the four themes", async ({
  page,
}) => {
  const { url, ids } = await hubWithHobs();
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${url}/#/hobs/${ids.Aldric}/chat`);
  const nav = sidebar(page);
  await expect(nav.getByRole("button", { name: "Find or jump to" })).toBeVisible();
  for (const name of ["Home", "For you", "Usage", "Settings"]) {
    await expect(nav.getByRole("link", { name, exact: true }).first()).toBeVisible();
  }
  const camps = nav.getByRole("list", { name: "Camps" });
  await expect(camps.getByRole("link")).toHaveText([/Plan the spring launch|Draft the release notes/, /Plan|Draft/]);
  const direct = nav.getByRole("list", { name: "Direct messages" });
  await expect(direct.getByRole("link", { name: "Aldric, resting" })).toHaveAttribute("aria-current", "page");
  await expect(direct.getByRole("link", { name: "Ada, resting" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "All your hobs" })).toHaveAttribute("href", /#\/hobs$/);
  await expect(nav.getByRole("img", { name: "Owner" })).toBeVisible();
  // The old chevron and the hob card are gone: the window's width sets the sidebar's.
  await expect(nav.getByRole("button", { name: /Expand the sidebar|Collapse the sidebar/ })).toHaveCount(0);

  for (const theme of THEMES) {
    await pickTheme(page, theme);
    expect(await widthOf(page)).toBe(276);
    await expectAccessible(page, sidebar(page));
    await shot(page, `sidebar-wide--${theme}`);
  }
});

test("at 1024 and 960 wide the sidebar is a 76px rail of icons, each named, in the four themes", async ({ page }) => {
  const { url, ids } = await hubWithHobs();
  for (const width of [1024, 960]) {
    await page.setViewportSize({ width, height: 760 });
    await page.goto(`${url}/#/hobs/${ids.Ada}/chat`);
    const nav = sidebar(page);
    expect(await widthOf(page)).toBe(76);
    // Labels and section headings are hidden; every item keeps its name and shows it on hover.
    await expect(nav.getByText("Direct messages", { exact: true })).toBeHidden();
    await expect(nav.getByRole("link", { name: "Ada, resting" })).toHaveAttribute("aria-current", "page");
    await nav.getByRole("link", { name: "Usage", exact: true }).hover();
    await expect(page.getByRole("tooltip")).toHaveText("Usage");
    const camp = nav.getByRole("link", { name: "Plan the spring launch" });
    await expect(camp).toBeVisible();
    const box = await camp.boundingBox();
    expect(box?.width).toBe(48);
  }
  await page.setViewportSize({ width: 1024, height: 760 });
  for (const theme of THEMES) {
    await pickTheme(page, theme);
    expect(await widthOf(page)).toBe(76);
    await expectAccessible(page, sidebar(page));
    await shot(page, `sidebar-narrow--${theme}`);
  }
  // Wider again, the labels come back.
  await page.setViewportSize({ width: 1280, height: 760 });
  await expect(sidebar(page).getByText("Direct messages", { exact: true })).toBeVisible();
  expect(await widthOf(page)).toBe(276);
});

test("a hob's direct message opens its chat, a camp opens itself, and Find opens the finder", async ({ page }) => {
  const { url, ids } = await hubWithHobs();
  await page.goto(`${url}/#/usage`);
  const nav = sidebar(page);
  await nav.getByRole("link", { name: "Ada, resting" }).click();
  await expect(page).toHaveURL(new RegExp(`#/hobs/${ids.Ada}/(chat|threads/[^/?]+)$`));
  await expect(page.getByRole("dialog")).toHaveCount(0);

  const camp = nav.getByRole("list", { name: "Camps" }).getByRole("link", { name: "Plan the spring launch" });
  await camp.click();
  await expect(page).toHaveURL(new RegExp(`#/hobs/${ids.Aldric}/threads/`));
  await expect(camp).toHaveAttribute("aria-current", "page");

  await nav.getByRole("button", { name: "Find or jump to" }).click();
  await expect(page.getByRole("dialog", { name: "Jump anywhere" })).toBeVisible();
  await page.keyboard.press("Escape");

  await nav.getByRole("link", { name: "Summon a hob" }).click();
  await expect(page).toHaveURL(/#\/summon/);
});

test("Camps and Direct messages hold their place while they load, then say when they are empty", async ({ page }) => {
  dataDir = emptyDataDir();
  hub = await startHub(dataDir);
  const current = hub;
  const done = await fetch(`${current.url}/api/setup`, {
    method: "PATCH",
    headers: { "content-type": "application/json", ...current.headers },
    body: JSON.stringify({ completed: true, connectedProviders: ["claude-code"] }),
  });
  expect(done.ok).toBe(true);
  // The sidebar's and the hobs' reads wait until the test lets them through.
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(/\/api\/(sidebar|agents)(\?|$)/, async (route) => {
    await held;
    await route.continue();
  });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${current.url}/#/`);
  const nav = sidebar(page);
  await expect(nav.getByRole("list", { name: "Camps" })).toHaveAttribute("aria-busy", "true");
  await expect(nav.getByRole("list", { name: "Direct messages" })).toHaveAttribute("aria-busy", "true");

  release();
  await expect(nav.getByText("No camps yet.")).toBeVisible();
  await expect(nav.getByText("No hobs yet.")).toBeVisible();
  await expect(nav.locator("[aria-busy=true]")).toHaveCount(0);
  await expectAccessible(page, nav);
});

test("Camps lists five camps, then Show more, and always shows the open camp", async ({ page }) => {
  const { url, ids } = await hubWithHobs();
  // Aldric has two camps already; five more make seven.
  const titles = ["Camp three", "Camp four", "Camp five", "Camp six", "Camp seven"];
  for (const title of titles) await campAt(hub as Hub, ids.Aldric ?? "", title);
  await page.goto(`${url}/#/hobs/${ids.Aldric}`);
  const nav = sidebar(page);
  const list = nav.getByRole("list", { name: "Camps" });
  const camps = list.getByRole("link");

  await expect(camps).toHaveCount(5);
  const more = nav.getByRole("button", { name: "Show 2 more" });
  await expect(more).toHaveAttribute("aria-expanded", "false");

  await more.click();
  await expect(camps).toHaveCount(7);
  await nav.getByRole("button", { name: "Show fewer" }).click();
  await expect(camps).toHaveCount(5);

  // A hidden camp that is open shows in its place, and Show more counts one fewer.
  const shown = await camps.evaluateAll((links) => links.map((link) => link.getAttribute("aria-label") ?? ""));
  const target = ["Plan the spring launch", "Draft the release notes", ...titles].find(
    (title) => !shown.includes(title),
  ) as string;
  await nav.getByRole("button", { name: "Show 2 more" }).click();
  await list.getByRole("link", { name: target }).click();
  await nav.getByRole("button", { name: "Show fewer" }).click();
  await expect(list.getByRole("link", { name: target })).toHaveAttribute("aria-current", "page");
  await expect(nav.getByRole("button", { name: "Show 1 more" })).toBeVisible();
});

test("with many hobs only Camps and Direct messages scroll: the places above and you below stay on screen", async ({
  page,
}) => {
  const { url } = await hubWithHobs(Array.from({ length: 22 }, (_, i) => `Hob ${i + 3}`));
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(url);
  const nav = sidebar(page);
  const last = nav.getByRole("link", { name: /^Hob 24, / });
  await expect(last).toBeAttached();

  for (const control of [
    nav.getByRole("link", { name: "Settings", exact: true }).first(),
    nav.getByRole("button", { name: "Find or jump to" }),
    nav.getByRole("img", { name: "Owner" }),
  ]) {
    await expect(control).toBeInViewport();
  }
  await expect(last).not.toBeInViewport();

  // Scrolling the list brings the last hob into view and leaves the rest where it was.
  await last.scrollIntoViewIfNeeded();
  await expect(last).toBeInViewport();
  await expect(nav.getByRole("link", { name: "Home", exact: true })).toBeInViewport();
  await expect(nav.getByRole("img", { name: "Owner" })).toBeInViewport();
});

test("a browser tab shows no window title strip, which belongs to the desktop app", async ({ page }) => {
  const { url } = await hubWithHobs();
  await page.goto(url);
  await expect(sidebar(page)).toBeVisible();
  await expect(page.getByRole("banner")).toHaveCount(0);
});

/**
 * Shows the camp `campId` as one you share with Aldric and Ada. The hub's members can't be added
 * from the app yet, so only the sidebar's section is changed; its last line and author are the hub's.
 */
const shareCamp = async (page: Page, campId: string, members: ReadonlyArray<string>) => {
  await page.route(/\/api\/sidebar(\?|$)/, async (route) => {
    const response = await route.fetch();
    const read = (await response.json()) as {
      sidebar: { camps: Array<{ threadId: string; section: string; others: Array<unknown> }> };
    };
    for (const camp of read.sidebar.camps) {
      if (camp.threadId !== campId) continue;
      camp.section = "shared-camp";
      camp.others = members.map((id) => ({ kind: "hob", id }));
    }
    await route.fulfill({ response, json: read });
  });
};

test("a shared camp's row names who wrote its last line as it lands, in the four themes, and the rail shows only its faces", async ({
  page,
  browser,
}) => {
  dataDir = emptyDataDir();
  hub = await startHub(dataDir, { HOBBOTS_TEST_PEOPLE: "on" });
  const current = hub;
  const api = async (method: string, path: string, body: unknown = {}) => {
    const response = await fetch(`${current.url}/api${path}`, {
      method,
      headers: { "content-type": "application/json", ...current.headers },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
    return response.json() as Promise<{ readonly id: string }>;
  };
  await api("PATCH", "/setup", { completed: true, connectedProviders: ["claude-code"] });
  const ids: Record<string, string> = {};
  for (const [i, name] of ["Aldric", "Ada"].entries()) {
    const made = await api("POST", "/agents", {
      id: randomUUID(),
      name,
      role: "assistant",
      roleTitle: "Assistant",
      sigil: "assistant",
      hat: "pointed",
      tool: "none",
      lookSeed: 1000 + i * 337,
      lookColor: "violet",
      runtime: "claude-code",
      model: null,
      effort: null,
      instructions: "",
    });
    ids[name] = made.id;
  }
  const camp = await campAt(current, ids.Aldric ?? "", "Shop team");
  await shareCamp(page, camp.id, [ids.Aldric ?? "", ids.Ada ?? ""]);

  // Bruna asks from her own device; Aldric answers, so his reply is the last line.
  const [bruna] = testPeople(current);
  if (bruna === undefined) throw new Error("The hub added no test people.");
  const { context, watch } = await signInAs(browser, current, bruna);
  // A change from a browser carries its own origin (ADR 021).
  const asked = await context.request.post(`${current.url}/api/threads/${camp.id}/messages`, {
    data: { content: "One caption idea each?" },
    headers: { origin: current.url },
  });
  expect(asked.ok(), await asked.text()).toBe(true);

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${current.url}/#/usage`);
  const nav = sidebar(page);
  const row = nav.getByRole("listitem").filter({ has: page.getByRole("link", { name: "Shop team" }) });
  await expect(row).toContainText("Aldric: Echo: One caption idea each?", { timeout: 20_000 });

  // A line you write names you, as it lands.
  await page.goto(camp.url);
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  await composer.fill("Keep the quiet one");
  await composer.press("Enter");
  await expect(page.getByRole("main").getByText("Echo: Keep the quiet one").first()).toBeVisible({ timeout: 20_000 });
  await expect(row).toContainText("Aldric: Echo: Keep the quiet one");

  for (const theme of THEMES) {
    await pickTheme(page, theme);
    await expect(row).toContainText("Aldric: Echo: Keep the quiet one");
    await expectAccessible(page, sidebar(page));
    await shot(page, `sidebar-last-author--${theme}`);
  }

  // The rail shows only the camp's faces: no last line.
  await page.setViewportSize({ width: 1024, height: 760 });
  expect(await widthOf(page)).toBe(76);
  await expect(row.getByText(/Aldric: /)).toBeHidden();
  for (const theme of THEMES) {
    await pickTheme(page, theme);
    await expectAccessible(page, sidebar(page));
    await shot(page, `sidebar-last-author-narrow--${theme}`);
  }

  await watch.checkOpenPages();
  expect(watch.breaks()).toEqual([]);
  await context.close();
});
