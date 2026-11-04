import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { emptyDataDir, expect, type Hub, removeDataDir, startHub, test } from "./hub.ts";

// Issue #389: the Workbench's Terminal, the commands a Task ran and what they printed (ADR 023).

let hub: Hub | undefined;
let dataDir = "";
let folder = "";

test.afterEach(async () => {
  await hub?.stop();
  hub = undefined;
  removeDataDir(dataDir);
  rmSync(folder, { recursive: true, force: true });
});

/** A hub past setup with Aldric, who works in a folder of his own beside the hub's data. */
const aldricHub = async () => {
  dataDir = emptyDataDir();
  folder = realpathSync(mkdtempSync(`${dataDir}-aldric-`));
  writeFileSync(join(folder, "notes.md"), "# Notes\n");
  hub = await startHub(dataDir);
  const { url, headers } = hub;
  const api = async (method: string, path: string, body: unknown) => {
    const response = await fetch(`${url}/api${path}`, {
      method,
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
    return response.json() as Promise<{ readonly id: string }>;
  };
  await api("PATCH", "/setup", { completed: true, connectedProviders: ["claude-code"] });
  const aldric = await api("POST", "/agents", {
    id: randomUUID(),
    name: "Aldric",
    role: "assistant",
    roleTitle: "Assistant",
    sigil: "assistant",
    hat: null,
    tool: null,
    lookSeed: 4000,
    lookColor: "amber",
    runtime: "claude-code",
    model: null,
    effort: null,
    instructions: "",
  });
  await api("PATCH", `/agents/${aldric.id}/permissions`, { ownFolders: [folder] });
  return { url, aldric: aldric.id };
};

/** A prompt line that makes the fake call a Task tool. */
const hubTool = (tool: string, input: object) => `fake:hub ${tool} ${JSON.stringify(input)}`;
/** A prompt line that makes the fake run a command, with what it prints and how it exits. */
const run = (input: object) => `fake:run ${JSON.stringify(input)}`;

/** Sends a message to Aldric and waits until his turn is underway. */
const send = async (page: Page, lines: ReadonlyArray<string>) => {
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  await composer.fill(lines.join("\n"));
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeVisible();
};

/** Opens the Task's Workbench from its card in the chat, on its Terminal. */
const openTerminal = async (page: Page, title: string) => {
  const card = page.getByRole("region", { name: `Aldric's work on ${title}` });
  await card.getByRole("button", { name: "Open in Workbench" }).click();
  const bench = page.getByRole("region", { name: `Workbench for ${title}` });
  await bench.getByRole("tab", { name: /^Terminal/ }).click();
  return { card, bench, panel: bench.getByRole("tabpanel", { name: /^Terminal/ }) };
};

// covers UX-002, UX-006, PE-005
test("[TC-UX-045] a finished Task's Terminal shows its commands as history: where each ran, whether it succeeded and its output, redacted and folded", async ({
  page,
}) => {
  const { url, aldric } = await aldricHub();
  await page.goto(`${url}/#/hobs/${aldric}/new`);
  // In one turn Aldric runs three commands, one failing, one printing a token, one printing a lot.
  await send(page, [
    "Check the notes",
    run({ command: "npm run lint", output: "notes.md: 2 problems\n", exitCode: 1 }),
    run({ command: "echo deploy", output: "using ghp_0123456789abcdefghijklmnopqrstuvwxyzAB\n", exitCode: 0 }),
    "fake:tool Bash seq 30000",
    hubTool("start_quest", { key: "quest", goal: "Check the notes" }),
    hubTool("complete_task", { key: "done", summary: "Checked." }),
  ]);
  const card = page.getByRole("region", { name: "Aldric's work on Check the notes" });
  await expect(card).toContainText("Aldric finished this", { timeout: 30_000 });
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeHidden({ timeout: 30_000 });

  const { bench, panel } = await openTerminal(page, "Check the notes");
  // A finished Task's Terminal is history, never a live session, and nothing in it takes typing.
  await expect(bench.locator("header").first()).toContainText("History");
  await expect(panel).toContainText("3 commands · 1 failed");
  await expect(panel).toContainText("A record of what ran. You cannot type here.");
  await expect(panel.getByRole("textbox")).toHaveCount(0);

  // Each command, in the order it ran, with its state; the failed one with its exit code.
  const commands = panel.getByRole("list", { name: "Commands" }).getByRole("listitem");
  await expect(commands).toHaveCount(3);
  const lint = commands.nth(0);
  await expect(lint).toContainText("npm run lint");
  await expect(lint).toContainText("Failed · exit code 1");
  await expect(lint).toContainText(folder);
  await expect(lint).toContainText("notes.md: 2 problems");
  await expect(lint.getByRole("figure", { name: "Output" })).toBeVisible();

  // Output is redacted before it is kept.
  const deploy = commands.nth(1);
  await expect(deploy).toContainText("Succeeded");
  await expect(deploy).toContainText("[redacted: GitHub token]");
  await expect(deploy).not.toContainText("ghp_0123456789");

  // Long output shows its start and end, with how much was left out and the whole log a click away.
  const long = commands.nth(2);
  await expect(long).toContainText("seq 30000");
  await expect(long).toContainText(/left out here/);
  await expect(long).toContainText("30000");
  const log = long.getByRole("link", { name: /^Open the full log/ });
  const href = await log.getAttribute("href");
  const whole = await page.evaluate(
    async (address) => (await fetch(address ?? "", { credentials: "include" })).text(),
    href,
  );
  expect(whole.split("\n")).toHaveLength(30_001);

  // A command folds away and stays folded when the Terminal is left and opened again.
  await lint.getByRole("button", { name: /npm run lint/ }).click();
  await expect(lint.getByRole("figure", { name: "Output" })).toBeHidden();
  await bench.getByRole("tab", { name: /^Summary/ }).click();
  await bench.getByRole("tab", { name: /^Terminal/ }).click();
  await expect(lint.getByRole("figure", { name: "Output" })).toBeHidden();
  await expect(long.getByRole("figure", { name: "Output" })).toBeVisible();
});

// covers UX-002, UX-006
test("[TC-UX-046] while a turn runs the Terminal is Live: a running command counts its time, then reads Cut off when the turn is stopped", async ({
  page,
}) => {
  const { url, aldric } = await aldricHub();
  await page.goto(`${url}/#/hobs/${aldric}/new`);
  // The first turn starts the Quest, so the next turn's commands belong to its Attempt.
  await send(page, ["Watch the build", hubTool("start_quest", { key: "quest", goal: "Watch the build" })]);
  const card = page.getByRole("region", { name: "Aldric's work on Watch the build" });
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeHidden({ timeout: 30_000 });

  // The second turn runs a command that keeps running until the turn ends.
  await send(page, ["Keep watching", "fake:tool Bash echo started", "fake:tool Bash sleep 600"]);
  const { bench, panel } = await openTerminal(page, "Watch the build");
  await expect(bench.locator("header").first()).toContainText("●Live");
  const commands = panel.getByRole("list", { name: "Commands" }).getByRole("listitem");
  await expect(commands).toHaveCount(2, { timeout: 20_000 });
  await expect(panel).toContainText("2 commands · 1 running");
  await expect(commands.nth(0)).toContainText("Succeeded");
  await expect(commands.nth(0)).toContainText("started");
  const sleeping = commands.nth(1);
  await expect(sleeping).toContainText(/Running · \d+ sec/);
  // Claude Code reports a command's output only when it ends, so the Terminal says so.
  await expect(sleeping).toContainText("Its output shows when it ends.");
  // The clock counts on while it runs.
  const first = await sleeping.textContent();
  await expect.poll(async () => sleeping.textContent(), { timeout: 5_000 }).not.toBe(first);

  // Stopped, the turn ends with the command still running: whether it finished is not known.
  await bench.getByRole("button", { name: "← Back to chat" }).click();
  await page.getByRole("button", { name: "■ Stop" }).click();
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeHidden({ timeout: 30_000 });
  await openTerminal(page, "Watch the build");
  await expect(sleeping).toContainText("Cut off", { timeout: 20_000 });
  await expect(sleeping).toContainText("The turn ended while this ran, so whether it finished is not known.");
});
