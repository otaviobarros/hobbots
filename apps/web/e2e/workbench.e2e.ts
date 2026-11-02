import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { emptyDataDir, expect, type Hub, removeDataDir, startHub, test } from "./hub.ts";

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
const script = (tool: string, input: object) => `fake:hub ${tool} ${JSON.stringify(input)}`;

// covers UX-002, UX-006
test("[TC-UX-021] a finished Task's Workbench opens on Summary, greys out the Terminal it did not use and goes back to the same chat", async ({
  page,
}) => {
  const { url, aldric } = await aldricHub();
  await page.goto(`${url}/#/hobs/${aldric}/new`);
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  // In one turn Aldric edits a file with a file tool, runs no command and finishes the Task.
  await composer.fill(
    [
      "Tidy the notes",
      'fake:write notes.md "# Notes\\n\\nTidied.\\n"',
      script("start_quest", { key: "quest", goal: "Tidy the notes" }),
      script("complete_task", { key: "done", summary: "The notes are tidy." }),
    ].join("\n"),
  );
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeVisible();
  const card = page.getByRole("region", { name: "Aldric's work on Tidy the notes" });
  await expect(card).toContainText("Aldric finished this", { timeout: 30_000 });
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeHidden({ timeout: 30_000 });

  // Pinned, and with a message left unsent, the Workbench opens from the card in the chat's place.
  await page.getByRole("tab", { name: "Quest" }).click();
  const room = page.getByRole("region", { name: "Control room for Tidy the notes" });
  await room.getByRole("button", { name: "Pin" }).click();
  await composer.fill("A thought for later");
  await card.getByRole("button", { name: "Open in Workbench" }).click();
  const bench = page.getByRole("region", { name: "Workbench for Tidy the notes" });
  await expect(bench.getByRole("heading", { name: "Tidy the notes" })).toBeFocused();
  await expect(bench).toContainText("Done");
  await expect(bench).toContainText("Aldricasked by You");
  await expect(bench).toContainText("Claude Code");
  await expect(composer).toBeHidden();

  // Summary opens first; a tab the Task did not use is greyed out but opens and says so.
  const tabs = bench.getByRole("tablist", { name: "Workbench views" });
  await expect(tabs.getByRole("tab")).toHaveText([
    "SummaryHistory",
    "ChangesHistory",
    "FilesHistory",
    "TerminalNot used in this Task",
    "BrowserComing soon",
  ]);
  const summary = tabs.getByRole("tab", { name: /^Summary/ });
  await expect(summary).toHaveAttribute("aria-selected", "true");
  await expect(bench.getByRole("tabpanel", { name: /^Summary/ })).toBeVisible();

  // The arrow keys move between the tabs; each opens, the Terminal and the Browser saying why.
  await summary.focus();
  await page.keyboard.press("ArrowLeft");
  const browser = tabs.getByRole("tab", { name: /^Browser/ });
  await expect(browser).toBeFocused();
  await expect(bench.getByRole("tabpanel", { name: /^Browser/ })).toContainText(
    "Watching a hob use a browser comes in a later update.",
  );
  await page.keyboard.press("ArrowLeft");
  await expect(tabs.getByRole("tab", { name: /^Terminal/ })).toHaveAttribute("aria-selected", "true");
  await expect(bench.getByRole("tabpanel", { name: /^Terminal/ })).toContainText(
    "Aldric did not use the terminal in this task.",
  );
  await expect(page).toHaveURL(/tab=terminal/);

  // Escape goes back to the same chat, with the message still unsent and the Quest still pinned.
  await page.keyboard.press("Escape");
  await expect(bench).toBeHidden();
  await expect(composer).toHaveValue("A thought for later");
  await expect(room.getByRole("button", { name: "Pin" })).toHaveAttribute("aria-pressed", "true");

  // Opened again it starts on Summary.
  await card.getByRole("button", { name: "Open in Workbench" }).click();
  await expect(bench.getByRole("tab", { name: /^Summary/ })).toHaveAttribute("aria-selected", "true");
  await bench.getByRole("button", { name: "← Back to chat" }).click();
  await expect(bench).toBeHidden();
});

// covers UX-002, UX-006
test("[TC-UX-022] the Workbench opens from the Task drawer and the Quest tab, and goes back to the drawer it came from with its unsent note", async ({
  page,
}) => {
  const { url, aldric } = await aldricHub();
  await page.goto(`${url}/#/hobs/${aldric}/new`);
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  await composer.fill(["Tidy the notes", script("start_quest", { key: "quest", goal: "Tidy the notes" })].join("\n"));
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeVisible();
  const card = page.getByRole("region", { name: "Aldric's work on Tidy the notes" });
  await expect(card).toBeVisible({ timeout: 20_000 });

  // From the drawer, Back to the task reopens the drawer with its unsent note.
  await card.getByRole("button", { name: "Show details" }).click();
  const drawer = page.getByRole("complementary", { name: "Tidy the notes, Task details" });
  const note = drawer.getByRole("textbox", { name: "Tell Aldric about this task" });
  await note.fill("Keep the headings short");
  await drawer.getByRole("button", { name: "Open in Workbench" }).click();
  const bench = page.getByRole("region", { name: "Workbench for Tidy the notes" });
  await expect(bench).toBeVisible();
  await expect(drawer).toBeHidden();
  await bench.getByRole("button", { name: "← Back to the task" }).click();
  await expect(drawer).toBeVisible();
  await expect(note).toHaveValue("Keep the headings short");

  // From the Quest tab, the open Task's controls open its Workbench.
  await page.getByRole("tab", { name: "Quest" }).click();
  const controls = page.getByRole("region", { name: "Controls for Tidy the notes" });
  await controls.getByRole("button", { name: "Open in Workbench" }).click();
  await expect(bench).toBeVisible();
  await expect(bench.getByRole("tab", { name: /^Summary/ })).toHaveAttribute("aria-selected", "true");
});
