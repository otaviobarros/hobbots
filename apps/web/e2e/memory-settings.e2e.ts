import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_MEMORY_SETTINGS } from "@hobbots/domain";
import type { Locator } from "@playwright/test";
import { emptyDataDir, expect, type Hub, removeDataDir, startHub, test } from "./hub.ts";

let hub: Hub | undefined;
let dataDir = "";

test.beforeEach(() => {
  dataDir = emptyDataDir();
});

test.afterEach(async () => {
  await hub?.stop();
  hub = undefined;
  removeDataDir(dataDir);
});

const finishSetup = async (started: Hub, connectedProviders: ReadonlyArray<string> = []) => {
  const response = await fetch(`${started.url}/api/setup`, {
    method: "PATCH",
    headers: { ...started.headers, "content-type": "application/json" },
    body: JSON.stringify({ completed: true, connectedProviders }),
  });
  if (!response.ok) throw new Error(`Finishing setup answered ${response.status}`);
};

const stored = () => JSON.parse(readFileSync(join(dataDir, "memory-settings.json"), "utf8")) as Record<string, unknown>;

// covers ADR 028, ADR 037, OP-002
test("[TC-GEN-222] chooses the hub's brain from one list in Your data, sees shares follow the preset in Safety, and memory's line in Usage", async ({
  page,
}) => {
  hub = await startHub(dataDir);
  await finishSetup(hub, ["claude-code", "codex"]);
  await page.goto(`${hub.url}/#/settings/data`);
  const card = page.getByRole("region", { name: "The hub's brain" });
  const brain = card.getByRole("combobox", { name: "The hub's brain" });
  const chosen = (list: Locator) => list.locator("option:checked");
  // Browser tests run without the engine, so memory is off and the hobs work without it.
  const memory = page.getByRole("region", { name: "Memory", exact: true });
  await expect(memory).toContainText("Memory is turned off on this hub.");
  await expect(memory).toContainText("a hob saves what it learns as it works, with no extra model call");
  // One list holds every connected runtime's models, grouped by provider, each one's smallest recommended.
  await expect(brain.locator("optgroup")).toHaveCount(2);
  await expect(brain.locator('optgroup[label="Claude"] option')).toHaveText(["Fake Thinker (recommended)"]);
  await expect(brain.locator('optgroup[label="ChatGPT"] option')).toHaveText(["Fake Coder (recommended)"]);
  await expect(chosen(brain)).toHaveText("Fake Thinker (recommended)");
  await expect(card).toContainText("Runs at low effort: this work needs no more.");
  await expect(card).toContainText("Uses your Claude Code sign-in.");
  await expect(card).not.toContainText("API key");

  await brain.selectOption({ label: "Fake Coder (recommended)" });
  await expect(card).toContainText("Uses your ChatGPT sign-in through Codex.");
  await card.getByRole("button", { name: "Choose a model per task…" }).click();
  await expect(card.getByText("For memory", { exact: true })).toBeVisible();
  await expect(card.getByText("For chats and camps", { exact: true })).toBeVisible();
  const task = (name: string) => card.getByRole("combobox", { name, exact: true });
  await task("Summing up a chat").selectOption({ label: "No AI" });
  await expect(chosen(task("Summing up a chat"))).toHaveText("No AI");
  await task("Judgment calls").selectOption({ label: "Fake Coder" });
  await expect(task("Check now").locator("option", { hasText: "No AI" })).toHaveCount(0);
  await expect
    .poll(() => stored().tasks)
    .toEqual({
      summaries: "none",
      check: "same",
      answers: "same",
      brief: "same",
      chapters: "same",
      judgments: "fake-coder",
    });
  expect(stored()).toMatchObject({ provider: "chatgpt", model: null, effort: "low" });

  // No AI says what it means, and is kept after a reload.
  await brain.selectOption({ label: "No AI" });
  await expect(card).toContainText("with no AI");
  await expect(card).not.toContainText("Runs at low effort");
  await page.reload();
  await expect(chosen(brain)).toHaveText("No AI");

  // Safety: a project share asks under Balanced and goes through under Trusting; About you always asks.
  await page.goto(`${hub.url}/#/settings/safety`);
  const learn = page.getByRole("region", { name: "What hobs learn" });
  const project = learn.getByRole("radiogroup", { name: "A hob shares with a project" });
  const about = learn.getByRole("radiogroup", { name: "A hob changes About you" });
  await expect(project.getByRole("radio", { name: "Ask me" })).toBeChecked();
  await page.getByText("Trusting", { exact: true }).click();
  await expect(project.getByRole("radio", { name: "Let it through" })).toBeChecked();
  await expect(about.getByRole("radio", { name: "Ask me" })).toBeChecked();
  await expect(about.getByRole("radio", { name: "Let it through" })).toBeDisabled();

  // Usage: memory's line, with the way back to the hub's brain.
  await page.goto(`${hub.url}/#/usage`);
  const usage = page.getByRole("region", { name: "Memory" });
  await expect(usage).toContainText("No AI: memory makes no model calls.");
  await usage.getByRole("link", { name: "Choose the hub's brain" }).click();
  await expect(chosen(brain)).toHaveText("No AI");
});

// covers ADR 028, ADR 037
test("[TC-GEN-224] keeps a choice the hub could not save, sends it again or goes back, and brings an effort chosen before back to low", async ({
  page,
}) => {
  // An effort chosen before the brain ran at low effort only.
  writeFileSync(join(dataDir, "memory-settings.json"), JSON.stringify({ ...DEFAULT_MEMORY_SETTINGS, effort: "high" }));
  hub = await startHub(dataDir);
  await finishSetup(hub, ["claude-code", "codex"]);
  // The hub refuses the first two saves, then takes them.
  let refusals = 2;
  await page.route("**/api/memory/settings", async (route) => {
    if (refusals-- > 0) await route.fulfill({ status: 500, body: "" });
    else await route.continue();
  });
  await page.goto(`${hub.url}/#/settings/data`);
  const card = page.getByRole("region", { name: "The hub's brain" });
  const brain = card.getByRole("combobox", { name: "The hub's brain" });
  const chosen = brain.locator("option:checked");
  await expect(chosen).toHaveText("Fake Thinker (recommended)");
  await expect(card).toContainText("Runs at high effort, chosen before.");

  // The refused choice stays shown, with a way back to the one the brain still runs with.
  await brain.selectOption({ label: "Fake Coder (recommended)" });
  await expect(card.getByRole("alert")).toContainText("could not save this choice");
  await expect(chosen).toHaveText("Fake Coder (recommended)");
  await card.getByRole("button", { name: "Keep the one before" }).click();
  await expect(chosen).toHaveText("Fake Thinker (recommended)");
  await expect(card.getByRole("alert")).toHaveCount(0);

  // Refused again, then sent again as it was: a pick from the list runs at low effort.
  await brain.selectOption({ label: "Fake Coder (recommended)" });
  await expect(chosen).toHaveText("Fake Coder (recommended)");
  await card.getByRole("button", { name: "Try again" }).click();
  await expect(card.getByRole("alert")).toHaveCount(0);
  await expect.poll(() => stored()).toMatchObject({ provider: "chatgpt", effort: "low" });
  await expect(card).toContainText("Runs at low effort: this work needs no more.");

  // The effort chosen before is gone with it, and so is the way back to low.
  await expect(card.getByRole("button", { name: "Use low effort" })).toHaveCount(0);
});

// covers ADR 037, OP-001
test("[TC-GEN-226] setup shows the hub's brain once a provider connects, on its smallest model, and saves it on Continue", async ({
  page,
}) => {
  hub = await startHub(dataDir);
  await page.goto(hub.url);
  await page.getByRole("link", { name: "Get started" }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Which AI should your hobs think with?" })).toBeVisible();
  const card = page.getByRole("region", { name: "The hub's brain" });
  await expect(card).toHaveCount(0);

  // Only ChatGPT through Codex: the brain moves to its smallest model, at low effort, recommended.
  await page.getByRole("button", { name: "Connect Codex" }).click();
  const brain = card.getByRole("combobox", { name: "The hub's brain" });
  await expect(brain.locator("option:checked")).toHaveText("Fake Coder (recommended)");
  await expect(brain.locator("optgroup")).toHaveCount(1);
  await expect(card.getByText("Recommended", { exact: true })).toBeVisible();
  await expect(card).toContainText("at low reasoning effort");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Who should help you first?" })).toBeVisible();
  await expect.poll(() => stored()).toMatchObject({ provider: "chatgpt", model: null, effort: "low" });

  // Back in the step, No AI saves at once and says what it means.
  await page.goBack();
  await brain.selectOption({ label: "No AI" });
  await expect(card).toContainText("follow simple rules, with no AI");
  await expect(card.getByText("Recommended", { exact: true })).toHaveCount(0);
  await expect.poll(() => stored()).toMatchObject({ provider: "none" });
});

// covers ADR 028
test("[TC-GEN-225] says when the desktop app could not show the memory files, and tries again", async ({ page }) => {
  hub = await startHub(dataDir);
  await finishSetup(hub);
  // The desktop app's bridge: no folder yet the first time, then it opens.
  await page.addInitScript(() => {
    let calls = 0;
    Object.assign(window, { hobbots: { showMemoryFiles: async () => ++calls > 1 } });
  });
  await page.goto(`${hub.url}/#/settings/data`);
  const card = page.getByRole("region", { name: "Memory" });
  await card.getByRole("button", { name: "Show the files" }).click();
  await expect(card.getByRole("alert")).toContainText("could not open the memory files");
  await card.getByRole("button", { name: "Try again" }).click();
  await expect(card.getByRole("alert")).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Show the files" })).toBeEnabled();
});
