import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { emptyDataDir, type Hub, removeDataDir, startHub } from "./hub.ts";

let hub: Hub | undefined;
let dataDir = "";

test.afterEach(async () => {
  await hub?.stop();
  hub = undefined;
  removeDataDir(dataDir);
});

/** A hub past setup with 20 resting hobs; Wick is the only Cartographer. */
const hubWithTwentyHobs = async () => {
  dataDir = emptyDataDir();
  hub = await startHub(dataDir);
  const api = async (method: string, path: string, body: unknown) => {
    const response = await fetch(`${hub?.url}/api${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
    return response.json() as Promise<{ readonly id: string }>;
  };
  await api("PATCH", "/setup", { completed: true, connectedProviders: ["claude-code"] });
  const ids: Record<string, string> = {};
  for (let i = 0; i < 20; i++) {
    const name = i === 13 ? "Wick" : `Hob ${i + 1}`;
    const hob = await api("POST", "/agents", {
      id: randomUUID(),
      name,
      ...(i === 13
        ? { role: null, roleTitle: "Cartographer", sigil: "assistant", hat: null, tool: null }
        : i === 4 || i === 9
          ? { role: "qa", roleTitle: "QA engineer", sigil: "qa", hat: "horned", tool: "lantern" }
          : { role: "assistant", roleTitle: "Assistant", sigil: "assistant", hat: "pointed", tool: "none" }),
      lookSeed: 1000 + i * 337,
      lookColor: "violet",
      runtime: "claude-code",
      model: null,
      effort: null,
      instructions: "",
    });
    ids[name] = hob.id;
  }
  return { url: hub.url, ids };
};

// covers UX-001
test("[TC-UX-001] with 20 hobs the scene shows six, the hall holds 14 and the filter finds a hob by role title", async ({
  page,
}) => {
  const { url } = await hubWithTwentyHobs();
  await page.goto(url);

  const scene = page.getByRole("region", { name: "Your hobs right now" });
  await expect(scene.getByRole("link", { name: /^Open chat with/ })).toHaveCount(6);
  await expect(scene.getByRole("button", { name: "Open the hall: 14 more hobs" })).toContainText("14 in the hall");

  // Past 12 hobs, Resting starts folded; its count chip unfolds it.
  const all = page.getByRole("region", { name: "All hobs" });
  const tiles = all.getByRole("link", { name: /^Open chat with/ });
  await expect(all.getByRole("button", { name: /^Resting/ })).toHaveAttribute("aria-expanded", "false");
  await expect(tiles).toHaveCount(0);
  await scene.getByRole("button", { name: "20 resting" }).click();
  await expect(all.getByRole("button", { name: /^Resting/ })).toHaveAttribute("aria-expanded", "true");
  await expect(tiles).toHaveCount(20);

  await all.getByRole("searchbox", { name: "Find a hob by name or role" }).fill("carto");
  await expect(tiles).toHaveCount(1);
  await expect(all.getByRole("link", { name: /^Open chat with Wick, Cartographer/ })).toBeVisible();
});

// covers UX-001
test("[TC-UX-004] Home tiles show each hob's sigil and role, and the filter finds hobs by role", async ({ page }) => {
  const { url } = await hubWithTwentyHobs();
  await page.goto(url);
  const all = page.getByRole("region", { name: "All hobs" });
  await page.getByRole("region", { name: "Your hobs right now" }).getByRole("button", { name: "20 resting" }).click();

  await all.getByRole("searchbox", { name: "Find a hob by name or role" }).fill("QA");
  const tiles = all.getByRole("link", { name: /^Open chat with/ });
  await expect(tiles).toHaveCount(2);
  for (const name of ["Hob 5", "Hob 10"]) {
    const tile = all.getByRole("link", { name: `Open chat with ${name}, QA engineer, ready` });
    await expect(tile).toContainText("QA engineer · ready");
    // The sigil is decorative: the role is read once, from its title in words.
    await expect(tile.locator('[data-slot="sigil-badge"]')).toHaveAttribute("aria-hidden", "true");
  }
});

// covers UX-001
test("[TC-UX-002] ⌘K opens a hob's chat from any page", async ({ page }) => {
  const { url, ids } = await hubWithTwentyHobs();
  await page.goto(`${url}/#/usage`);
  await expect(page.getByRole("navigation", { name: "Sections" })).toBeVisible();

  await page.keyboard.press("ControlOrMeta+k");
  const finder = page.getByRole("dialog", { name: "Jump to a hob" });
  await finder.getByRole("combobox", { name: "Find a hob by name or role" }).fill("wick");
  await expect(finder.getByRole("option")).toHaveCount(1);
  await page.keyboard.press("Enter");

  await expect(finder).toBeHidden();
  await expect(page).toHaveURL(new RegExp(`#/hobs/${ids.Wick}/new$`));
});

// covers UX-001
test("[TC-UX-003] the finder keeps the hob chosen with the arrows in sight", async ({ page }) => {
  const { url } = await hubWithTwentyHobs();
  await page.goto(url);
  await expect(page.getByRole("region", { name: "All hobs" })).toBeVisible();

  await page.keyboard.press("ControlOrMeta+k");
  const finder = page.getByRole("dialog", { name: "Jump to a hob" });
  await expect(finder.getByRole("option")).toHaveCount(20);
  const chosen = finder.getByRole("option", { selected: true });
  await expect(chosen).toBeInViewport();

  // Up from the first hob wraps to the last one, below the fold of the list.
  await page.keyboard.press("ArrowUp");
  await expect(finder.getByRole("option").last()).toHaveAttribute("aria-selected", "true");
  await expect(chosen).toBeInViewport();

  // Down wraps back to the first hob, scrolled back into sight.
  await page.keyboard.press("ArrowDown");
  await expect(finder.getByRole("option").first()).toHaveAttribute("aria-selected", "true");
  await expect(chosen).toBeInViewport();

  await page.keyboard.press("ArrowUp");
  const hobId = (await chosen.getAttribute("id"))?.replace("hob-jump-", "");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`#/hobs/${hobId}/new$`));
});
