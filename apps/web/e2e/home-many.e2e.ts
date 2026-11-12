import { randomUUID } from "node:crypto";

import { emptyDataDir, expect, type Hub, removeDataDir, startHub, test } from "./hub.ts";

let hub: Hub | undefined;
/** A hob on the scene's stage, named "<name>, <role>, <state>". */
const stageHob = /^(Hob \d+|Wick), /;
let dataDir = "";

test.afterEach(async () => {
  await hub?.stop();
  hub = undefined;
  removeDataDir(dataDir);
});

/** A hub past setup with `count` resting hobs; the 14th, Wick, is the only Cartographer. */
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
  return { url: hub.url, ids, api };
};

// covers UX-001
test("[TC-UX-001] with 20 hobs the scene shows five and the hall door opens Your hobs", async ({ page }) => {
  const { url } = await hubWithHobs(20);
  await page.goto(url);

  const scene = page.getByRole("region", { name: "Your hobs right now" });
  await expect(scene.getByRole("button", { name: stageHob })).toHaveCount(5);
  const door = scene.getByRole("link", { name: "Open Your hobs: 15 more hobs wait in the hall" });
  await expect(door).toContainText("+15 in the hall");
  // Home no longer unfolds the hall into a list of its own.
  await expect(page.getByRole("region", { name: "All hobs" })).toHaveCount(0);

  await door.click();
  await expect(page).toHaveURL(/#\/hobs$/);
  await expect(page.getByRole("main", { name: "Your hobs" })).toBeVisible();
});

// covers UX-001
test("[TC-UX-161] at 960px with 24 hobs no hob on the stage covers the summary or Summon", async ({ page }) => {
  await page.setViewportSize({ width: 960, height: 800 });
  const { url } = await hubWithHobs(24);
  await page.goto(url);

  const scene = page.getByRole("region", { name: "Your hobs right now" });
  await expect(scene.getByText("24 hobs. Nothing needs you.")).toBeVisible();
  const summon = scene.getByRole("link", { name: "+ Summon a hob" });
  const text = scene.getByRole("heading", { level: 1 }).locator("..");
  const shown = scene.getByRole("button", { name: stageHob });
  await expect(shown.first()).toBeVisible();

  // The hobs with no room on the stage wait in the hall, so the door counts them too.
  const count = await shown.count();
  expect(count).toBeLessThan(5);
  await expect(scene.getByRole("link", { name: /^Open Your hobs:/ })).toContainText(`+${24 - count} in the hall`);

  const boxes = [await summon.boundingBox(), await text.boundingBox()];
  for (const hob of await shown.all()) {
    const box = await hob.boundingBox();
    for (const other of boxes) {
      if (box === null || other === null) throw new Error("a box is missing");
      expect(box.x >= other.x + other.width || box.y >= other.y + other.height).toBe(true);
    }
  }
  // Live work shows as bubbles on the stage, not in a card of its own.
  await expect(page.getByRole("region", { name: "Happening now" })).toHaveCount(0);
});

// covers UX-001
test("[TC-UX-004] the hall door opens Your hobs on the family a count chip picked", async ({ page }) => {
  const { url } = await hubWithHobs(20);
  await page.goto(url);
  const scene = page.getByRole("region", { name: "Your hobs right now" });
  await scene.getByRole("radio", { name: "Resting 20" }).click();
  await scene.getByRole("link", { name: /^Open Your hobs:/ }).click();
  await expect(page).toHaveURL(/#\/hobs\?show=resting$/);
});

// covers UX-001
test("[TC-UX-005] with five or fewer hobs the Home scene shows each hob's sigil and role", async ({ page }) => {
  const { url } = await hubWithHobs(5);
  await page.goto(url);
  const scene = page.getByRole("region", { name: "Your hobs right now" });
  await expect(scene.getByRole("button", { name: stageHob })).toHaveCount(5);
  await expect(scene.getByRole("link", { name: /^Open Your hobs:/ })).toHaveCount(0);

  const qa = scene.getByRole("button", { name: "Hob 5, QA engineer, ready" });
  await expect(qa).toContainText("Hob 5");
  await expect(qa.locator('[data-slot="sigil-badge"]')).toHaveAttribute("aria-hidden", "true");
  await expect(scene.getByRole("button", { name: /^Hob 1, Assistant,/ })).toBeVisible();
});

// covers UX-001
test("[TC-UX-091] clicking a hob in the Home scene opens a peek whose Open chat starts its chat", async ({ page }) => {
  const { url, ids } = await hubWithHobs(3);
  await page.goto(url);
  const scene = page.getByRole("region", { name: "Your hobs right now" });
  const hob = scene.getByRole("button", { name: "Hob 2, Assistant, ready" });

  await hob.click();
  const peek = page.getByRole("dialog", { name: "Hob 2" });
  await expect(peek).toContainText("Resting");
  await expect(peek).toContainText("Assistant");
  // A resting hob works on no Task, so there is no Workbench to open.
  await expect(peek.getByRole("link", { name: "Open Workbench" })).toHaveCount(0);

  // Escape closes the peek and returns focus to the hob.
  await page.keyboard.press("Escape");
  await expect(peek).toBeHidden();
  await expect(hob).toBeFocused();

  await hob.click();
  await page.getByRole("dialog", { name: "Hob 2" }).getByRole("link", { name: "Open chat" }).click();
  await expect(page).toHaveURL(new RegExp(`#/hobs/${ids["Hob 2"]}/chat$`));
});

// covers UX-001
test("[TC-UX-002] ⌘K opens a hob's page from any page", async ({ page }) => {
  const { url, ids } = await hubWithHobs(20);
  await page.goto(`${url}/#/usage`);
  await expect(page.getByRole("navigation", { name: "Sections" })).toBeVisible();

  await page.keyboard.press("ControlOrMeta+k");
  const finder = page.getByRole("dialog", { name: "Jump anywhere" });
  await finder.getByRole("combobox", { name: "Find a hob, thread or message" }).fill("wick");
  await expect(finder.getByRole("option")).toHaveCount(1);
  await page.keyboard.press("Enter");

  await expect(finder).toBeHidden();
  await expect(page).toHaveURL(new RegExp(`#/hobs/${ids.Wick}$`));
});

// covers UX-001
test("[TC-UX-003] the finder keeps the hob chosen with the arrows in sight", async ({ page }) => {
  const { url } = await hubWithHobs(20);
  await page.goto(url);
  await expect(page.getByRole("region", { name: "Your hobs right now" })).toBeVisible();

  await page.keyboard.press("ControlOrMeta+k");
  const finder = page.getByRole("dialog", { name: "Jump anywhere" });
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
  const hobId = (await chosen.getAttribute("id"))?.replace("hob-jump-hob-", "");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`#/hobs/${hobId}$`));
});

// covers UX-001, CH-002
test("[TC-UX-092] Pick up where you left off lists a chat with its last line and opens it", async ({ page }) => {
  const { url, ids, api } = await hubWithHobs(1);
  const hob = ids["Hob 1"] ?? "";
  const thread = await api("POST", `/agents/${hob}/threads`, {});
  await api("POST", `/threads/${thread.id}/messages`, { content: "Draft the release notes" });
  await page.goto(url);

  const pickUp = page.getByRole("region", { name: "Pick up where you left off" });
  const row = pickUp.getByRole("link", { name: /Draft the release notes/ });
  // The fake runtime echoes the prompt, and its reply becomes the chat's last line.
  await expect(row).toContainText(/Hob 1\s*·\s*Echo: Draft the release notes/);
  await row.click();
  await expect(page).toHaveURL(new RegExp(`#/hobs/${hob}/threads/${thread.id}$`));
});
