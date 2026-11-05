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
  await expect(pick("Provider", "Claude")).toBeChecked();
  await expect(pick("Model", "Haiku")).toBeChecked();
  await expect(pick("Effort", "Low")).toBeChecked();
  await expect(card).toContainText("can't hand Claude a key yet");

  await pick("Provider", "ChatGPT").click();
  await expect(pick("Model", "GPT-5.4 mini")).toBeChecked();
  await pick("Effort", "High").click();
  await expect(card).toContainText("High effort can be too slow for summaries");
  await card.getByRole("button", { name: "Choose a model per task…" }).click();
  await pick("Summing up a chat", "No AI").click();
  await expect(pick("Summing up a chat", "No AI")).toBeChecked();
  const stored = () =>
    JSON.parse(readFileSync(join(dataDir, "memory-settings.json"), "utf8")) as Record<string, unknown>;
  await expect.poll(() => stored().tasks).toEqual({ summaries: "none", check: "same", answers: "same" });
  expect(stored()).toMatchObject({ provider: "chatgpt", model: "mini", effort: "high" });

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
