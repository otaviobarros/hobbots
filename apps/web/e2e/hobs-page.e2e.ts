import { randomUUID } from "node:crypto";

import { emptyDataDir, expect, type Hub, removeDataDir, startHub, test } from "./hub.ts";

let hub: Hub | undefined;
let dataDir = "";

test.afterEach(async () => {
  await hub?.stop();
  hub = undefined;
  removeDataDir(dataDir);
});

/** A hub past setup with 24 resting hobs; Wick is the only Cartographer. */
const hubWithHobs = async (count: number) => {
  dataDir = emptyDataDir();
  hub = await startHub(dataDir);
  const api = async (method: string, path: string, body: unknown) => {
    const response = await fetch(`${hub?.url}/api${path}`, {
      method,
      headers: { "content-type": "application/json", ...hub?.headers },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
    return response.json() as Promise<{ readonly id: string }>;
  };
  await api("PATCH", "/setup", { completed: true, connectedProviders: ["claude-code"] });
  const ids: Record<string, string> = {};
  for (let i = 0; i < count; i++) {
    const name = i === 13 ? "Wick" : `Hob ${i + 1}`;
    const hob = await api("POST", "/agents", {
      id: randomUUID(),
      name,
      role: null,
      roleTitle: i === 13 ? "Cartographer" : "Assistant",
      sigil: "assistant",
      hat: null,
      tool: null,
      lookSeed: 1000 + i * 337,
      lookColor: (["violet", "moss", "amber", "rose", "sky", "ember"] as const)[i % 6],
      runtime: "claude-code",
      model: null,
      effort: null,
      instructions: "",
    });
    ids[name] = hob.id;
  }
  return { url: hub.url, ids };
};

// covers UX-001, UX-005
test("[TC-UX-089] Your hobs shows every hob as a card, filters by state, finds by role and opens a hob's page", async ({
  page,
}) => {
  const { url, ids } = await hubWithHobs(24);
  await page.goto(`${url}/#/hobs`);
  const main = page.getByRole("main", { name: "Your hobs" });
  await expect(main.getByRole("heading", { name: "Your hobs", level: 1 })).toBeVisible();
  await expect(main).toContainText("0 need you · 0 working · 24 resting");

  // Every hob is a card, followed by the Summon card.
  const cards = main.getByRole("link", { name: /, New$/ });
  await expect(cards).toHaveCount(24);
  await expect(main.getByRole("link", { name: "Wick, New" })).toContainText("Cartographer");
  await expect(main.getByRole("link", { name: "Wick, New" })).toContainText("No chats yet");
  await expect(main.getByRole("link", { name: /^Summon a hob/ })).toHaveCount(2);

  // The chips count each state; a filter lives in the URL.
  const chips = main.getByRole("radiogroup", { name: "Show" });
  await expect(chips.getByRole("radio", { name: "All 24" })).toHaveAttribute("aria-checked", "true");
  await expect(chips.getByRole("radio", { name: "Resting 24" })).toBeVisible();
  await chips.getByRole("radio", { name: "Need you 0" }).click();
  await expect(page).toHaveURL(/\?show=needs$/);
  await expect(main).toContainText("No hob needs you right now.");
  await expect(cards).toHaveCount(0);
  await chips.getByRole("radio", { name: "All 24" }).click();
  await expect(page).toHaveURL(/#\/hobs$/);

  // Find a hob by its role.
  await main.getByRole("searchbox", { name: "Find a hob" }).fill("cartog");
  await expect(cards).toHaveCount(1);
  await main.getByRole("searchbox", { name: "Find a hob" }).fill("nobody");
  await expect(main).toContainText("No hob by that name or role.");
  await main.getByRole("button", { name: "Clear the search" }).click();
  await expect(cards).toHaveCount(24);

  // "/" anywhere on the page jumps to the search, and its keycap says so while it is empty.
  const find = main.getByRole("searchbox", { name: "Find a hob" });
  await expect(find).toHaveAttribute("aria-keyshortcuts", "/");
  await expect(main.locator("kbd", { hasText: "/" })).toBeVisible();
  await main.getByRole("heading", { name: "Your hobs", level: 1 }).click();
  await expect(find).not.toBeFocused();
  await page.keyboard.press("/");
  await expect(find).toBeFocused();
  await expect(find).toHaveValue("");

  // A card opens the hob's page, and its breadcrumb comes back.
  await main.getByRole("link", { name: "Wick, New" }).click();
  await expect(page).toHaveURL(new RegExp(`#/hobs/${ids.Wick}$`));
  await page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link", { name: "Your hobs" }).click();
  await expect(page).toHaveURL(/#\/hobs$/);

  // Retired hobs open in the Archive.
  await main.getByRole("link", { name: /^Retired hobs · 0/ }).click();
  await expect(page).toHaveURL(/#\/archive\?tab=hobs$/);
});
