import { randomUUID } from "node:crypto";

import { emptyDataDir, expect, type Hub, removeDataDir, startHub, test } from "./hub.ts";

let hub: Hub | undefined;
let dataDir = "";

test.afterEach(async () => {
  await hub?.stop();
  hub = undefined;
  removeDataDir(dataDir);
});

/** A hub past setup with Aldric, who has two threads, and Ada. */
const hubWithHobs = async () => {
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
  for (const [i, name] of ["Aldric", "Ada"].entries()) {
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
  await expect(nav.getByRole("link", { name: "Aldric, resting" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Ada, resting" })).toBeVisible();

  await nav.getByRole("button", { name: "Expand the sidebar" }).click();
  await nav.getByRole("link", { name: "Aldric, resting" }).click();
  await expect(page).toHaveURL(new RegExp(`#/hobs/${ids.Aldric}$`));
  const thread = nav.getByRole("link", { name: "Plan the spring launch" });
  await expect(thread).toBeVisible();
  await expect(nav.getByRole("link", { name: "Draft the release notes" })).toBeVisible();

  await thread.click();
  await expect(page).toHaveURL(new RegExp(`#/hobs/${ids.Aldric}/threads/`));
  await expect(nav.getByRole("link", { name: "Plan the spring launch" })).toHaveAttribute("aria-current", "page");

  await expect(nav.getByRole("link", { name: "Summon a hob" })).toBeVisible();
});
