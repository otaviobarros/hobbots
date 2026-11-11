import { readFileSync } from "node:fs";
import { join } from "node:path";
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

const finishSetup = async (started: Hub) => {
  const response = await fetch(`${started.url}/api/setup`, {
    method: "PATCH",
    headers: { ...started.headers, "content-type": "application/json" },
    body: JSON.stringify({ completed: true }),
  });
  if (!response.ok) throw new Error(`Finishing setup answered ${response.status}`);
};

// covers ADR 028, OP-002
test("[TC-GEN-222] chooses the memory model in Your data, sees shares follow the preset in Safety, and memory's line in Usage", async ({
  page,
}) => {
  hub = await startHub(dataDir);
  await finishSetup(hub);
  await page.goto(`${hub.url}/#/settings/data`);
  const card = page.getByRole("region", { name: "Memory" });
  const pick = (group: string, name: string) =>
    card.getByRole("radiogroup", { name: group, exact: true }).getByRole("radio", { name, exact: true });
  // Browser tests run without the engine, so memory is off and the hobs work without it.
  await expect(card).toContainText("Memory is turned off on this hub.");
  await expect(card).toContainText("a hob saves what it learns as it works, with no extra model call");
  // The models are the runtime's own, as the brain picker lists them: its smallest is the default.
  await expect(pick("Provider", "Claude")).toBeChecked();
  await expect(pick("Model", "Fake Thinker")).toBeChecked();
  await expect(pick("Effort", "Low")).toBeChecked();
  await expect(card).toContainText("Uses your Claude Code sign-in.");
  await expect(card).not.toContainText("API key");

  await pick("Provider", "ChatGPT").click();
  await expect(pick("Model", "Fake Coder")).toBeChecked();
  await expect(card).toContainText("Uses your ChatGPT sign-in through Codex.");
  await pick("Effort", "High").click();
  await expect(card).toContainText("High effort can be too slow for summaries");
  await card.getByRole("button", { name: "Choose a model per task…" }).click();
  await pick("Summing up a chat", "No AI").click();
  await expect(pick("Summing up a chat", "No AI")).toBeChecked();
  const stored = () =>
    JSON.parse(readFileSync(join(dataDir, "memory-settings.json"), "utf8")) as Record<string, unknown>;
  await expect.poll(() => stored().tasks).toEqual({
    summaries: "none",
    check: "same",
    answers: "same",
    brief: "same",
    chapters: "same",
    judgments: "same",
  });
  expect(stored()).toMatchObject({ provider: "chatgpt", model: null, effort: "high" });

  // No AI hides the model, and is kept after a reload.
  await pick("Provider", "No AI").click();
  await expect(card.getByRole("radiogroup", { name: "Model", exact: true })).toHaveCount(0);
  await page.reload();
  await expect(pick("Provider", "No AI")).toBeChecked();

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

  // Usage: memory's line, with the way back to the memory model.
  await page.goto(`${hub.url}/#/usage`);
  const usage = page.getByRole("region", { name: "Memory" });
  await expect(usage).toContainText("No AI: memory makes no model calls.");
  await usage.getByRole("link", { name: "Choose the memory model" }).click();
  await expect(pick("Provider", "No AI")).toBeVisible();
});

// covers ADR 028
test("[TC-GEN-224] keeps a choice the hub could not save, and sends it again or goes back", async ({ page }) => {
  hub = await startHub(dataDir);
  await finishSetup(hub);
  // The hub refuses the first two saves, then takes them.
  let refusals = 2;
  await page.route("**/api/memory/settings", async (route) => {
    if (refusals-- > 0) await route.fulfill({ status: 500, body: "" });
    else await route.continue();
  });
  await page.goto(`${hub.url}/#/settings/data`);
  const card = page.getByRole("region", { name: "Memory" });
  const pick = (group: string, name: string) =>
    card.getByRole("radiogroup", { name: group, exact: true }).getByRole("radio", { name, exact: true });
  await expect(pick("Effort", "Low")).toBeChecked();

  // The refused choice stays shown, with a way back to the one memory still runs with.
  await pick("Effort", "Medium").click();
  await expect(card.getByRole("alert")).toContainText("could not save this choice");
  await expect(pick("Effort", "Medium")).toBeChecked();
  await card.getByRole("button", { name: "Keep the one before" }).click();
  await expect(pick("Effort", "Low")).toBeChecked();
  await expect(card.getByRole("alert")).toHaveCount(0);

  // Refused again, then sent again as it was.
  await pick("Effort", "Max").click();
  await expect(pick("Effort", "Max")).toBeChecked();
  await card.getByRole("button", { name: "Try again" }).click();
  await expect(card.getByRole("alert")).toHaveCount(0);
  await expect(pick("Effort", "Max")).toBeChecked();
  await expect
    .poll(() => (JSON.parse(readFileSync(join(dataDir, "memory-settings.json"), "utf8")) as { effort: string }).effort)
    .toBe("max");
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
