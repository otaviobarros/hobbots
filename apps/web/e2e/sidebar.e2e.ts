import { randomUUID } from "node:crypto";

import type { Page } from "@playwright/test";
import { campAt, emptyDataDir, expect, type Hub, removeDataDir, startHub, test } from "./hub.ts";

let hub: Hub | undefined;
let dataDir = "";

test.afterEach(async () => {
  await hub?.stop();
  hub = undefined;
  removeDataDir(dataDir);
});

/** A hub past setup with Aldric, who has two channels, Ada, and any `more` hobs named after them. */
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
    const channel = await api("POST", `/agents/${ids.Aldric}/camps`, {
      key: crypto.randomUUID(),
      title,
      goal: null,
      private: false,
    });
    await api("POST", `/channels/${channel.id}/messages`, { content: title });
  }
  return { url: current.url, ids };
};

const sidebar = (page: Page) => page.getByRole("navigation", { name: "Sections" });

test("Camps lists five camps, then Show more, and always shows the open camp (#1431)", async ({ page }) => {
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
