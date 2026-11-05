import { randomUUID } from "node:crypto";

import { emptyDataDir, expect, type Hub, removeDataDir, startHub, test } from "./hub.ts";

let hub: Hub | undefined;
let dataDir = "";

test.afterEach(async () => {
  await hub?.stop();
  hub = undefined;
  removeDataDir(dataDir);
});

/** A hub past setup whose memory is the fake in `memory`, looked at every second. */
const hubWithMemory = async (memory: "empty" | "seeded" | "down") => {
  dataDir = emptyDataDir();
  hub = await startHub(dataDir, { HOBBOTS_FAKE_MEMORY: memory, HOBBOTS_MEMORY_LOOK_SECONDS: "1" });
  const started = hub;
  const api = async (method: string, path: string, body: unknown) => {
    const response = await fetch(`${started.url}/api${path}`, {
      method,
      headers: { "content-type": "application/json", ...started.headers },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
    return response.json() as Promise<{ readonly id: string }>;
  };
  await api("PATCH", "/setup", { completed: true, connectedProviders: ["claude-code"] });
  const summon = (name: string, lookSeed: number) =>
    api("POST", "/agents", {
      id: randomUUID(),
      name,
      role: null,
      roleTitle: "Writer",
      sigil: "assistant",
      hat: null,
      tool: null,
      lookSeed,
      lookColor: "moss",
      runtime: "claude-code",
      model: null,
      effort: null,
      instructions: "",
    });
  return { url: started.url, summon };
};

// covers ADR 028 (Browse, Read), #958
test("[TC-UX-951] Memory opens from the sidebar, shows what hobs learned, and reads a page with its changes", async ({
  page,
}) => {
  const { url, summon } = await hubWithMemory("seeded");
  const pip = await summon("Pip", 1201);
  await page.goto(`${url}/#/`);
  await page.getByRole("link", { name: "Memory", exact: true }).first().click();
  const main = page.getByRole("main", { name: "Memory" });
  await expect(main.getByRole("heading", { name: "Recently learned" })).toBeVisible();
  await expect(main.getByRole("link", { name: /Publishing a preview link/ })).toBeVisible();
  await expect(main).toContainText("Ask before sending anything outside the hub");

  // A hob's memory groups its pages by kind; a kind chip narrows the list.
  const nav = page.getByRole("navigation", { name: "Memory scopes" });
  await nav.getByRole("link", { name: /Pip/ }).click();
  await expect(page).toHaveURL(new RegExp(`scope=hob(%3A|:)${pip.id}`));
  await expect(main.getByRole("region", { name: "Gotchas" })).toBeVisible();
  await main.getByRole("radio", { name: /How-tos/ }).click();
  await expect(main.getByRole("region", { name: "Gotchas" })).toBeHidden();

  // A page reads as markdown, with its History; Show changes lays out what that version added.
  await main.getByRole("link", { name: /Publishing a preview link/ }).click();
  await expect(main.getByRole("heading", { name: "Publishing a preview link", level: 2 })).toBeVisible();
  await expect(main).toContainText("Learned by Pip");
  await main.getByRole("link", { name: "Show changes" }).click();
  await expect(main).toContainText("The first version of this page.");
  await expect(main.getByRole("listitem").filter({ hasText: "Copy the link from its result" }).first()).toBeVisible();
  await main.getByRole("link", { name: "Hide changes" }).click();
  await expect(main).not.toContainText("The first version of this page.");
});

// covers ADR 028 (Search, What changed), #958
test("[TC-UX-952] search finds pages across scopes, and What changed shows a new hob's saves as they land", async ({
  page,
}) => {
  const { url, summon } = await hubWithMemory("seeded");
  await summon("Pip", 1201);
  await page.goto(`${url}/#/memory`);
  const main = page.getByRole("main", { name: "Memory" });
  await page.getByRole("searchbox", { name: "Search memory" }).fill("preview");
  await page.getByRole("searchbox", { name: "Search memory" }).press("Enter");
  await expect(main.getByRole("heading", { name: /mention “preview”/ })).toBeVisible();
  await expect(main).toContainText("Publishing the site");
  await expect(main).toContainText("In Pip's memory");

  await page.getByRole("navigation", { name: "Memory scopes" }).getByRole("link", { name: "What changed" }).click();
  await expect(main.getByRole("heading", { name: "What changed", level: 2 })).toBeVisible();
  await expect(main).not.toContainText("Saved by Ada");
  // A hob summoned now saves its pages; the hub finds them within a look and streams them in.
  await summon("Ada", 1301);
  await expect(main.getByText("Saved by Ada").first()).toBeVisible({ timeout: 15_000 });
  await main.getByRole("radio", { name: /Yours/ }).click();
  await expect(main).not.toContainText("Saved by Ada");
});

// covers ADR 028 (Browse), #958
test("[TC-UX-953] with nothing remembered yet, Memory says how it fills", async ({ page }) => {
  const { url, summon } = await hubWithMemory("empty");
  await summon("Pip", 1201);
  await page.goto(`${url}/#/memory`);
  const main = page.getByRole("main", { name: "Memory" });
  await expect(main.getByRole("heading", { name: "Nothing remembered yet" })).toBeVisible();
  await expect(main).toContainText("A hob learns");
  await expect(page.getByText("1 hob · nothing remembered yet")).toBeVisible();
});

// covers ADR 028 (Browse), #958
test("[TC-UX-954] while memory is not answering, Memory says so and offers to try again", async ({ page }) => {
  const { url } = await hubWithMemory("down");
  await page.goto(`${url}/#/memory`);
  const main = page.getByRole("main", { name: "Memory" });
  await expect(main.getByText("Memory is not answering")).toBeVisible();
  await expect(page.getByText("Not answering · trying again every 30 seconds")).toBeVisible();
  await main.getByRole("button", { name: "Try again" }).click();
  await expect(main.getByText("Memory is not answering")).toBeVisible();
});
