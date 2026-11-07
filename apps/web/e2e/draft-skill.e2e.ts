import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import { expectAccessible } from "./accessibility.ts";
import { emptyDataDir, expect, type Hub, removeDataDir, startHub, test } from "./hub.ts";

// #1144: Add a skill › Write one › Draft it with a hob (ADR 029, Proactive hobs). You pick a hob, a
// new chat opens with a message to change, and the hob's draft waits in To review, attributed to that
// chat, for a Claude Code hob and a Codex hob alike, on a hub with the fake runtime.

let hub: Hub | undefined;
let dataDir = "";

test.afterEach(async () => {
  await hub?.stop();
  hub = undefined;
  removeDataDir(dataDir);
});

const skillMd = (name: string, body: string) =>
  `---\nname: ${name}\ndescription: What ${name} is for, and when to use it.\n---\n\n# ${name}\n\n${body}\n`;

/** A hub past setup with Ada on Claude Code, Cody on Codex, and Bram, who may never suggest a skill. */
const draftHub = async () => {
  dataDir = emptyDataDir();
  hub = await startHub(dataDir);
  const { url, headers } = hub;
  const api = async (method: string, path: string, body: unknown = {}) => {
    const response = await fetch(`${url}/api${path}`, {
      method,
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
    return response.json() as Promise<{ readonly id: string }>;
  };
  await api("PATCH", "/setup", {
    completed: true,
    connectedProviders: ["claude-code", "codex"],
    safetyPreset: "balanced",
  });
  const hob = (name: string, runtime: "claude-code" | "codex", lookSeed: number) =>
    api("POST", "/agents", {
      id: randomUUID(),
      name,
      role: null,
      roleTitle: "Builder",
      sigil: "assistant",
      hat: null,
      tool: null,
      lookSeed,
      lookColor: "moss",
      runtime,
      model: null,
      effort: null,
      instructions: "",
    });
  const ada = await hob("Ada", "claude-code", 1401);
  const cody = await hob("Cody", "codex", 1402);
  const bram = await hob("Bram", "claude-code", 1403);
  await api("PATCH", `/agents/${bram.id}/permissions`, { overrides: { "propose-skill": "deny" } });
  return { url, api, ada, cody };
};

/** From Write one, picks `name`, then sends the prefilled message with the fake runtime's `skill_propose` line. */
const draftWith = async (page: Page, url: string, name: string, skill: string) => {
  await page.goto(`${url}/#/skills?add=write`);
  const main = page.getByRole("main", { name: "Skills" });
  await main.getByRole("button", { name: /^Draft it with a hob/ }).click();
  await main
    .getByRole("list", { name: "Which hob drafts it?" })
    .getByRole("link", { name: new RegExp(`^${name}`) })
    .click();

  const composer = page.getByRole("textbox", { name: new RegExp(`^Message ${name}`) });
  await expect(composer).toHaveValue(/^Please write a new skill for my library and propose it/);
  await expect(composer).toHaveValue(/What it is for: /);
  await expectAccessible(page);
  const call = { key: skill, name: skill, instructions: skillMd(skill, "Tag, then push."), why: "You asked me to." };
  // What it is for, then the line the fake runtime turns into the hob's `skill_propose` call.
  const prefilled = await composer.inputValue();
  await composer.fill(
    `${prefilled.replace("What it is for: ", "What it is for: how we release")}\nfake:hub skill_propose ${JSON.stringify(call)}`,
  );
  await composer.press("Enter");
  await expect(page).toHaveURL(/threads\/[^/?#]+/, { timeout: 20_000 });
  await expectAccessible(page);
  return /threads\/([^/?#]+)/.exec(page.url())?.[1] ?? "";
};

// covers ADR 029 (Proactive hobs, The Skills page), #1144
test("[TC-UX-1144-01] Draft it with a hob offers only the hobs that may suggest skills, and passes the scan", async ({
  page,
}) => {
  const { url } = await draftHub();
  await page.goto(`${url}/#/skills?add=write`);
  const main = page.getByRole("main", { name: "Skills" });
  await expect(main.getByRole("link", { name: /Start from a blank skill/ })).toBeVisible({ timeout: 20_000 });
  const draft = main.getByRole("button", { name: /^Draft it with a hob/ });
  await expect(draft).toHaveAttribute("aria-expanded", "false");
  await draft.click();
  await expect(draft).toHaveAttribute("aria-expanded", "true");

  const picker = main.getByRole("list", { name: "Which hob drafts it?" });
  await expect(picker.getByRole("link")).toHaveCount(2);
  await expect(picker.getByRole("link", { name: /^Ada/ })).toBeVisible();
  await expect(picker.getByRole("link", { name: /^Cody/ })).toBeVisible();
  await expect(picker.getByRole("link", { name: /^Bram/ })).toHaveCount(0);
  await expectAccessible(page, main);
});

// covers ADR 029 (Proactive hobs, The Skills page), #1144
test("[TC-UX-1144-04] hobs that could not be read never read as none allowed, and Try again lists them", async ({
  page,
}) => {
  const { url } = await draftHub();
  // The hobs fail to read until the hub answers again; every other read answers.
  let down = true;
  await page.route(
    (address) => address.pathname === "/api/agents",
    async (route) => {
      if (down && route.request().method() === "GET")
        await route.fulfill({ status: 500, contentType: "application/json", body: "{}" });
      else await route.continue();
    },
  );
  await page.goto(`${url}/#/skills?add=write`);
  const main = page.getByRole("main", { name: "Skills" });
  await main.getByRole("button", { name: /^Draft it with a hob/ }).click();
  const failed = main.getByRole("alert").filter({ hasText: "Hobbots could not read your hobs" });
  await expect(failed).toBeVisible({ timeout: 20_000 });
  await expect(main.getByText("No hob may suggest skills now")).toHaveCount(0);
  await expectAccessible(page, main);

  down = false;
  await failed.getByRole("button", { name: "Try again" }).click();
  const picker = main.getByRole("list", { name: "Which hob drafts it?" });
  await expect(picker.getByRole("link")).toHaveCount(2, { timeout: 20_000 });
  await expect(failed).toHaveCount(0);
});

// covers ADR 029 (Proactive hobs, The Skills page), #1144
test("[TC-UX-1144-05] with no hob that may suggest skills, it says so and where to allow it", async ({ page }) => {
  const { url, api, ada, cody } = await draftHub();
  for (const hob of [ada, cody]) {
    await api("PATCH", `/agents/${hob.id}/permissions`, { overrides: { "propose-skill": "deny" } });
  }
  await page.goto(`${url}/#/skills?add=write`);
  const main = page.getByRole("main", { name: "Skills" });
  await main.getByRole("button", { name: /^Draft it with a hob/ }).click();
  await expect(main.getByText("No hob may suggest skills now")).toBeVisible({ timeout: 20_000 });
  await expect(main).toContainText("In a hob's Permissions, allow Suggest a new skill or a change");
  await expect(main.getByRole("list", { name: "Which hob drafts it?" })).toHaveCount(0);
  await expectAccessible(page, main);
});

for (const [name, runtime] of [
  ["Ada", "Claude Code"],
  ["Cody", "Codex"],
] as const) {
  // covers ADR 029 (Proactive hobs, The Skills page), #1144
  test(`[TC-UX-1144-0${name === "Ada" ? 2 : 3}] a ${runtime} hob drafts the skill in a new chat, and it waits in To review from that chat`, async ({
    page,
  }) => {
    const started = await draftHub();
    const hobId = name === "Ada" ? started.ada.id : started.cody.id;
    const threadId = await draftWith(page, started.url, name, "release-steps");

    await page.goto(`${started.url}/#/skills`);
    const main = page.getByRole("main", { name: "Skills" });
    const nav = page.getByRole("navigation", { name: "Skill scopes" });
    await expect(nav.getByRole("link", { name: /To review/ })).toContainText("1", { timeout: 20_000 });
    await expectAccessible(page);
    await nav.getByRole("link", { name: /To review/ }).click();
    const open = main.getByRole("article", { name: `${name} drafted a skill: Release steps` });
    await expect(open.getByRole("region", { name: "The skill" })).toContainText("Tag, then push.");
    await expectAccessible(page);
    await expect(open.getByRole("link", { name: "Open the chat" })).toHaveAttribute(
      "href",
      `/#/hobs/${hobId}/threads/${threadId}`,
    );

    await open.getByRole("button", { name: `Add it for ${name}` }).click();
    await expect(open.getByRole("status")).toHaveText(
      `Added Release steps r1 for ${name}. ${name} uses it from its next chat.`,
    );
    await expectAccessible(page);
  });
}
