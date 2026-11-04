import { randomUUID } from "node:crypto";

import { emptyDataDir, expect, type Hub, removeDataDir, startHub, test } from "./hub.ts";

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
    const thread = await api("POST", `/agents/${ids.Aldric}/threads`);
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
  await expect(nav.getByRole("button", { name: "Aldric, resting" })).toBeVisible();
  await expect(nav.getByRole("button", { name: "Ada, resting" })).toBeVisible();

  await nav.getByRole("button", { name: "Expand the sidebar" }).click();
  await nav.getByRole("button", { name: "Aldric, resting" }).click();
  await page.getByRole("dialog", { name: "Aldric" }).getByRole("link", { name: "Open page" }).click();
  await expect(page).toHaveURL(new RegExp(`#/hobs/${ids.Aldric}$`));
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
test("[TC-UX-143] a hob's tile opens its card, whose name, Open page and Profile go to the right places", async ({
  page,
}) => {
  const { url, ids } = await hubWithHobs();
  await page.goto(`${url}/#/usage`);
  const nav = sidebar(page);
  const tile = nav.getByRole("button", { name: "Ada, resting" });

  await tile.click();
  const card = page.getByRole("dialog", { name: "Ada" });
  await expect(card).toContainText("Resting");
  await expect(card.getByRole("region", { name: "Backpack" })).toContainText("Nothing to deal with right now.");
  await page.keyboard.press("Escape");
  await expect(card).toBeHidden();
  await expect(tile).toBeFocused();

  await tile.click();
  await card.getByRole("link", { name: "Ada", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`#/hobs/${ids.Ada}$`));

  await tile.click();
  await card.getByRole("link", { name: "Profile" }).click();
  await expect(page).toHaveURL(new RegExp(`#/hobs/${ids.Ada}/profile$`));

  await tile.click();
  await card.getByRole("button", { name: "Close" }).click();
  await expect(card).toBeHidden();
});

// covers UX-001
test("[TC-UX-161] with many hobs only the hob list scrolls: the sections and the chevron stay on screen", async ({
  page,
}) => {
  const { url } = await hubWithHobs(Array.from({ length: 22 }, (_, i) => `Hob ${i + 3}`));
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(url);
  const nav = sidebar(page);
  const last = nav.getByRole("button", { name: /^Hob 24, / });
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

test("[TC-UX-162] a browser tab shows no window title strip, which belongs to the desktop app", async ({ page }) => {
  const { url } = await hubWithHobs();
  await page.goto(url);
  await expect(sidebar(page)).toBeVisible();
  await expect(page.getByRole("banner")).toHaveCount(0);
});
