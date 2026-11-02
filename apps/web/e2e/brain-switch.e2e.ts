import type { Page } from "@playwright/test";
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

const api = async <A>(current: Hub, method: string, path: string, body?: unknown): Promise<A> => {
  const response = await fetch(`${current.url}${path}`, {
    method,
    headers: { ...current.headers, ...(body !== undefined && { "content-type": "application/json" }) },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${method} ${path} answered ${response.status}: ${await response.text()}`);
  return (await response.json()) as A;
};

type Hob = { readonly id: string; readonly runtime: string; readonly configVersion: number };

/** A hub with setup done and Pip on the fake Claude Code; the fake Codex stands beside it. */
const hubWithPip = async () => {
  const current = await startHub(dataDir);
  hub = current;
  await api(current, "PATCH", "/api/setup", { completed: true, connectedProviders: ["claude-code"] });
  const pip = await api<Hob>(current, "POST", "/api/agents", {
    name: "Pip",
    role: "writer",
    roleTitle: "Writer",
    sigil: "writer",
    hat: "pointed",
    tool: "quill",
    lookSeed: 4821,
    lookColor: "violet",
    runtime: "claude-code",
    model: "fake-thinker",
    effort: "medium",
    instructions: "",
  });
  return { current, pip };
};

const send = async (page: Page, text: string) => {
  const composer = page.getByRole("textbox", { name: /^Message Pip/ });
  await composer.fill(text);
  await composer.press("Enter");
};

// covers RT-001, CH-001
test("[TC-CH-184] the picker switches the thread's brain, the chat shows it, and a limited reply continues on Codex", async ({
  page,
}) => {
  const { current, pip } = await hubWithPip();
  await page.goto(`${current.url}/#/hobs/${pip.id}/new`);
  await send(page, "My cat is called Miso.");
  await expect(page.getByText("Echo: My cat is called Miso.")).toBeVisible();

  // The chip names the brain and opens the picker, by keyboard.
  const chip = page.getByRole("button", { name: /^Thinking with Claude Code · Fake Thinker/ });
  await chip.focus();
  await page.keyboard.press("Enter");
  const picker = page.getByRole("dialog", { name: "Think with" });
  await picker.getByRole("region", { name: "Codex" }).getByRole("button", { name: "Fake Coder" }).click();
  await expect(picker).toBeHidden();
  await expect(page.getByRole("button", { name: /^Thinking with Codex · Fake Coder/ })).toBeVisible();
  await expect(page.getByRole("note")).toContainText("The next reply thinks with Codex · Fake Coder");

  // Effort changes for the thread too, keeping its runtime and model.
  await page.getByRole("button", { name: /^Thinking with Codex · Fake Coder · Medium/ }).click();
  await page.getByRole("dialog", { name: "Think with" }).getByRole("button", { name: "High" }).click();
  await expect(page.getByRole("button", { name: /^Thinking with Codex · Fake Coder · High, ready/ })).toBeVisible();

  await send(page, "What is my cat called?");
  await expect(page.getByRole("note")).toContainText("Now thinking with Codex · Fake Coder");
  // The fake echoes its prompt, so the briefing it was given shows the earlier fact.
  await expect(page.getByText(/This thread so far[\s\S]*My cat is called Miso\./)).toBeVisible();
  // Only the thread changed.
  expect((await api<ReadonlyArray<Hob>>(current, "GET", "/api/agents"))[0]).toMatchObject({
    runtime: "claude-code",
    configVersion: 1,
  });

  // Back on Claude Code, a limited reply offers to continue on Codex.
  await page.getByRole("button", { name: /^Thinking with Codex/ }).click();
  await page.getByRole("button", { name: /^Back to Pip's default/ }).click();
  await send(page, "fake:limit write a poem");
  await expect(page.getByRole("button", { name: "Continue from here" })).toBeVisible();
  await page.getByRole("button", { name: "Continue with Codex" }).click();
  await expect(page.getByText(/Your previous reply was cut off/)).toBeVisible();
  const onCodex = page.getByRole("button", { name: /^Thinking with Codex, ready\. Change brain/ });
  await expect(onCodex).toBeVisible();

  // The brain the thread already uses can still become the hob's default.
  await onCodex.click();
  const again = page.getByRole("dialog", { name: "Think with" });
  await again.getByRole("switch", { name: "Also make it Pip's default" }).click();
  await again.getByRole("region", { name: "Codex" }).getByRole("button", { name: "Default model" }).click();
  await expect(again).toBeHidden();
  await expect
    .poll(async () => (await api<ReadonlyArray<Hob>>(current, "GET", "/api/agents"))[0])
    .toMatchObject({ runtime: "codex", configVersion: 2 });
});
