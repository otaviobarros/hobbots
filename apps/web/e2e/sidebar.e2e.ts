import { randomUUID } from "node:crypto";

import { campAt, emptyDataDir, expect, type Hub, removeDataDir, startHub, test } from "./hub.ts";

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

const sidebar = (page: import("@playwright/test").Page) => page.getByRole("navigation", { name: "Sections" });

// covers UX-001
test("[TC-UX-140] the sidebar starts collapsed, expands with its chevron or ⌘\\, and remembers the choice", async ({
  page,
}) => {
  const { url } = await hubWithHobs();
  await page.goto(url);
  const nav = sidebar(page);
  const toggle = nav.getByRole("button", { name: "Expand the sidebar" });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(nav).toHaveAttribute("data-open", "false");

  // The four sections, and no separate Hobs item.
  for (const name of ["Home", "Inbox", "Usage", "Settings"]) {
    await expect(nav.getByRole("link", { name, exact: true })).toBeVisible();
  }
  await expect(nav.getByRole("link", { name: "Hobs", exact: true })).toHaveCount(0);

  await toggle.click();
  await expect(nav).toHaveAttribute("data-open", "true");
  await expect(nav.getByRole("button", { name: "Collapse the sidebar" })).toHaveAttribute("aria-expanded", "true");

  await page.reload();
  await expect(sidebar(page)).toHaveAttribute("data-open", "true");

  await page.keyboard.press("ControlOrMeta+Backslash");
  await expect(sidebar(page)).toHaveAttribute("data-open", "false");
  await page.reload();
  await expect(sidebar(page)).toHaveAttribute("data-open", "false");
});

// covers UX-001
test("[TC-UX-141] every hob shows in the sidebar from any page, and the open hob lists its recent threads", async ({
  page,
}) => {
  const { url, ids } = await hubWithHobs();
  await page.goto(`${url}/#/usage`);
  const nav = sidebar(page);
  await expect(nav.getByRole("link", { name: "Aldric, resting" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Ada, resting" })).toBeVisible();

  await nav.getByRole("button", { name: "Expand the sidebar" }).click();
  await page.goto(`${url}/#/hobs/${ids.Aldric}`);
  const thread = nav.getByRole("link", { name: "Plan the spring launch" });
  await expect(thread).toBeVisible();
  await expect(nav.getByRole("link", { name: "Draft the release notes" })).toBeVisible();

  await thread.click();
  await expect(page).toHaveURL(new RegExp(`#/hobs/${ids.Aldric}/threads/`));
  await expect(nav.getByRole("link", { name: "Plan the spring launch" })).toHaveAttribute("aria-current", "page");

  await expect(nav.getByRole("link", { name: "Summon a hob" })).toBeVisible();
});

// covers UX-001
test("[TC-UX-142] the Hobs label above the sidebar's hobs opens Your hobs", async ({ page }) => {
  const { url } = await hubWithHobs();
  await page.goto(`${url}/#/usage`);
  const nav = sidebar(page);
  // Collapsed, the label is hidden; expanded, it links to Your hobs.
  await expect(nav.getByRole("link", { name: "Hobs: open Your hobs" })).toBeHidden();
  await nav.getByRole("button", { name: "Expand the sidebar" }).click();
  const label = nav.getByRole("link", { name: "Hobs: open Your hobs" });
  await expect(label).toHaveAttribute("href", /#\/hobs$/);
  await label.click();
  await expect(page).toHaveURL(/#\/hobs$/);
  await expect(page.getByRole("main", { name: "Your hobs" })).toBeVisible();
});

// covers UX-001
test("[TC-UX-143] a hob's tile opens its chat, with no card in between, and lists its chat and camps", async ({
  page,
}) => {
  const { url, ids } = await hubWithHobs();
  await page.goto(`${url}/#/usage`);
  const nav = sidebar(page);
  await nav.getByRole("button", { name: "Expand the sidebar" }).click();

  await nav.getByRole("link", { name: "Aldric, resting" }).click();
  await expect(page).toHaveURL(new RegExp(`#/hobs/${ids.Aldric}/(chat|threads/[^/?]+)$`));
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const list = nav.getByRole("list", { name: "Aldric's chat and camps" });
  await expect(list.getByRole("link", { name: "Chat", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(list.getByRole("link", { name: "Plan the spring launch" })).toBeVisible();
  await expect(nav.getByRole("list", { name: "Ada's chat and camps" })).toHaveCount(0);

  // Collapsed, the tile still goes straight to the chat.
  await nav.getByRole("button", { name: "Collapse the sidebar" }).click();
  await nav.getByRole("link", { name: "Ada, resting" }).click();
  await expect(page).toHaveURL(new RegExp(`#/hobs/${ids.Ada}/(chat|threads/[^/?]+)$`));
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

// covers UX-001
test("[TC-UX-1431-01] the open hob lists five camps, then Show more, and always shows its open camp", async ({
  page,
}) => {
  const { url, ids } = await hubWithHobs();
  // Aldric has two camps already; five more make seven.
  const titles = ["Camp three", "Camp four", "Camp five", "Camp six", "Camp seven"];
  for (const title of titles) await campAt(hub as Hub, ids.Aldric ?? "", title);
  await page.goto(`${url}/#/hobs/${ids.Aldric}`);
  const nav = sidebar(page);
  await nav.getByRole("button", { name: "Expand the sidebar" }).click();
  const list = nav.getByRole("list", { name: "Aldric's chat and camps" });
  const camps = list.getByRole("link").filter({ hasNotText: "Chat" });

  await expect(camps).toHaveCount(5);
  const more = list.getByRole("button", { name: "Show 2 more" });
  await expect(more).toHaveAttribute("aria-expanded", "false");

  await more.click();
  await expect(camps).toHaveCount(7);
  await list.getByRole("button", { name: "Show fewer" }).click();
  await expect(camps).toHaveCount(5);

  // A hidden camp that is open shows in its place, and Show more counts one fewer.
  const shown = await camps.allTextContents();
  const target = ["Plan the spring launch", "Draft the release notes", ...titles].find(
    (title) => !shown.some((text) => text.includes(title)),
  ) as string;
  await list.getByRole("button", { name: "Show 2 more" }).click();
  await list.getByRole("link", { name: target }).click();
  await list.getByRole("button", { name: "Show fewer" }).click();
  await expect(list.getByRole("link", { name: target })).toHaveAttribute("aria-current", "page");
  await expect(list.getByRole("button", { name: "Show 1 more" })).toBeVisible();
});

// covers UX-001
test("[TC-UX-161] with many hobs only the hob list scrolls: the sections and the chevron stay on screen", async ({
  page,
}) => {
  const { url } = await hubWithHobs(Array.from({ length: 22 }, (_, i) => `Hob ${i + 3}`));
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(url);
  const nav = sidebar(page);
  const last = nav.getByRole("link", { name: /^Hob 24, / });
  await expect(last).toBeAttached();

  for (const control of [
    nav.getByRole("link", { name: "Settings", exact: true }),
    nav.getByRole("link", { name: "Summon a hob" }),
    nav.getByRole("button", { name: "Expand the sidebar" }),
  ]) {
    await expect(control).toBeInViewport();
  }
  await expect(last).not.toBeInViewport();

  // Scrolling the list brings the last hob into view and leaves the rest where it was.
  await last.scrollIntoViewIfNeeded();
  await expect(last).toBeInViewport();
  await expect(nav.getByRole("link", { name: "Home", exact: true })).toBeInViewport();
  await expect(nav.getByRole("button", { name: "Expand the sidebar" })).toBeInViewport();
});

// covers UX-001
test("[TC-UX-164] in the collapsed sidebar a hob's row is as wide as a section's and centered on its tile", async ({
  page,
}) => {
  const { url } = await hubWithHobs(Array.from({ length: 22 }, (_, i) => `Hob ${i + 3}`));
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(url);
  const nav = sidebar(page);
  const section = await nav.getByRole("link", { name: "Home", exact: true }).boundingBox();
  const row = nav.getByRole("link", { name: /^Ada, / });
  const rowBox = await row.boundingBox();
  const tile = await row.locator(".size-hob-tile").boundingBox();
  if (!section || !rowBox || !tile) throw new Error("the sidebar rows did not render");

  // The hover, focus and selected background is the row, so it frames the tile evenly, even while
  // the hob list scrolls and keeps its scrollbar gutter.
  expect(rowBox.x).toBe(section.x);
  expect(rowBox.width).toBe(section.width);
  expect(tile.x - rowBox.x).toBeCloseTo(rowBox.x + rowBox.width - (tile.x + tile.width), 0);
  expect(tile.y - rowBox.y).toBeCloseTo(rowBox.y + rowBox.height - (tile.y + tile.height), 0);
});

test("[TC-UX-162] a browser tab shows no window title strip, which belongs to the desktop app", async ({ page }) => {
  const { url } = await hubWithHobs();
  await page.goto(url);
  await expect(sidebar(page)).toBeVisible();
  await expect(page.getByRole("banner")).toHaveCount(0);
});
