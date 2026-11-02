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

// covers UX-002, UX-006
test("[TC-UX-030] a finished Task's Summary says what was asked, what happened and what it made, and links each file into Changes and Files", async ({
  page,
}) => {
  const { url, aldric } = await aldricHub();
  await page.goto(`${url}/#/hobs/${aldric}/new`);
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  // In one turn Aldric edits the notes, writes a report, reports a finding and finishes with what it made.
  const report = join(folder, "report.md");
  await composer.fill(
    [
      "Tidy the notes",
      script("start_quest", { key: "quest", goal: "Tidy the notes" }),
      'fake:write notes.md "# Notes\\n\\nTidied.\\n"',
      'fake:write report.md "# What changed\\n"',
      script("report_checkpoint", { key: "found", kind: "finding", summary: "Two notes said the same thing." }),
      script("complete_task", {
        key: "done",
        summary: "The notes are tidy, and the report says what changed.",
        artifacts: [
          { kind: "file", label: "The report", value: report },
          { kind: "link", label: "The style guide", value: "https://example.com/style" },
        ],
      }),
    ].join("\n"),
  );
  await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeVisible();
  const card = page.getByRole("region", { name: "Aldric's work on Tidy the notes" });
  await expect(card).toContainText("Aldric finished this", { timeout: 30_000 });
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeHidden({ timeout: 30_000 });

  await card.getByRole("button", { name: "Open in Workbench" }).click();
  const bench = page.getByRole("region", { name: "Workbench for Tidy the notes" });
  const summary = bench.getByRole("tabpanel", { name: /^Summary/ });
  await expect(summary.getByRole("region", { name: "What you asked" })).toContainText("Tidy the notes");
  await expect(summary.getByRole("region", { name: "What happened" })).toContainText(
    "DoneTwo notes said the same thing.",
  );
  const made = summary.getByRole("region", { name: "What it made" });
  await expect(made.getByRole("link", { name: "https://example.com/style" })).toBeVisible();
  await expect(made.getByRole("button", { name: /^See the change to / })).toHaveText([
    /^Edited.*notes\.md$/,
    /^Added.*report\.md$/,
  ]);
  await expect(summary.getByRole("region", { name: "Still open" })).toContainText(
    "Nothing is waiting on you or anyone else.",
  );
  await expect(summary.getByRole("region", { name: "The result" })).toContainText(
    "The notes are tidy, and the report says what changed.",
  );
  // The buttons at the end name the tabs it used; it ran no command, so none names the Terminal.
  await expect(summary.getByRole("navigation", { name: "Open the other views" }).getByRole("button")).toHaveText([
    "See the 2 changed files",
    "See the 2 files",
  ]);

  // Each file opens its tab on that file.
  await made.getByRole("button", { name: "See the change to notes.md in Changes" }).click();
  await expect(bench.getByRole("tab", { name: /^Changes/ })).toHaveAttribute("aria-selected", "true");
  await expect(page).toHaveURL(/tab=changes/);
  expect(new URL(page.url().replace("/#/", "/")).searchParams.get("file")).toBe(join(folder, "notes.md"));
  await bench.getByRole("tab", { name: /^Summary/ }).click();
  await expect(page).not.toHaveURL(/file=/);
  await made.getByRole("button", { name: "See The report in Files" }).click();
  await expect(bench.getByRole("tab", { name: /^Files/ })).toHaveAttribute("aria-selected", "true");
  expect(new URL(page.url().replace("/#/", "/")).searchParams.get("file")).toBe(report);
});

// covers UX-002, UX-006
test("[TC-UX-031] a question waiting for you shows under Still open, and Answer in the chat goes back to it", async ({
  page,
}) => {
  const { url, aldric } = await aldricHub();
  await page.goto(`${url}/#/hobs/${aldric}/new`);
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  await composer.fill(
    [
      "Tidy the notes",
      script("start_quest", { key: "quest", goal: "Tidy the notes" }),
      script("ask", { key: "ask", question: "Should the headings be short?" }),
    ].join("\n"),
  );
  await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeVisible();
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeHidden({ timeout: 30_000 });

  const asks = page.getByRole("region", { name: "Aldric asks you" });
  await expect(asks).toContainText("Should the headings be short?");
  await page
    .getByRole("region", { name: "Aldric's work on Tidy the notes" })
    .getByRole("button", { name: "Open in Workbench" })
    .click();
  const bench = page.getByRole("region", { name: "Workbench for Tidy the notes" });
  const open = bench.getByRole("tabpanel", { name: /^Summary/ }).getByRole("region", { name: "Still open" });
  await expect(open).toContainText("A question for you");
  await expect(open).toContainText("Should the headings be short?");
  await expect(
    bench.getByRole("tabpanel", { name: /^Summary/ }).getByRole("region", { name: "The result" }),
  ).toContainText("No result yet.");

  await open.getByRole("button", { name: "Answer in the chat" }).click();
  await expect(bench).toBeHidden();
  await expect(asks).toBeVisible();
});

// covers UX-002, UX-006
test("[TC-UX-032] a Quest pinned from another thread sends Answer in the chat to the thread its question is in", async ({
  page,
}) => {
  const { url, aldric } = await aldricHub();
  await page.goto(`${url}/#/hobs/${aldric}/new`);
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  await composer.fill(
    [
      "Tidy the notes",
      script("start_quest", { key: "quest", goal: "Tidy the notes" }),
      script("ask", { key: "ask", question: "Should the headings be short?" }),
    ].join("\n"),
  );
  await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeVisible();
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeHidden({ timeout: 30_000 });
  const asks = page.getByRole("region", { name: "Aldric asks you" });
  await expect(asks).toBeVisible();
  const questThread = new URL(page.url().replace("/#/", "/")).pathname;

  // Pinned, the Quest follows to another thread, where its Workbench opens over that thread's chat.
  await page.getByRole("tab", { name: "Quest" }).click();
  const room = page.getByRole("region", { name: "Control room for Tidy the notes" });
  await room.getByRole("button", { name: "Pin" }).click();
  await page.goto(`${url}/#/hobs/${aldric}/new`);
  await composer.fill("Something else");
  await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeVisible();
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeHidden({ timeout: 30_000 });
  await expect(room).toContainText("Pinned from another thread");
  await room.getByRole("button", { name: /^Aldric · Tidy the notes/ }).click();
  await page
    .getByRole("region", { name: "Controls for Tidy the notes" })
    .getByRole("button", { name: "Open in Workbench" })
    .click();
  const bench = page.getByRole("region", { name: "Workbench for Tidy the notes" });
  const open = bench.getByRole("tabpanel", { name: /^Summary/ }).getByRole("region", { name: "Still open" });
  await expect(open).toContainText("Should the headings be short?");

  // Answer in the chat opens the Quest's own thread, where the question waits.
  await open.getByRole("button", { name: "Answer in the chat" }).click();
  await expect(bench).toBeHidden();
  expect(new URL(page.url().replace("/#/", "/")).pathname).toBe(questThread);
  await expect(asks).toContainText("Should the headings be short?");
});

// covers UX-002, UX-006
test("[TC-UX-033] Still open says nothing is open only once it could read what waits, and offers Try again when it could not", async ({
  page,
}) => {
  const { url, aldric } = await aldricHub();
  // Every read of the hobs' backpacks fails until the test lets them through.
  let failing = true;
  await page.route("**/api/backpack", (route) =>
    failing ? route.fulfill({ status: 500, body: "" }) : route.continue(),
  );
  await page.goto(`${url}/#/hobs/${aldric}/new`);
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  await composer.fill(
    [
      "Tidy the notes",
      script("start_quest", { key: "quest", goal: "Tidy the notes" }),
      script("complete_task", { key: "done", summary: "The notes are tidy." }),
    ].join("\n"),
  );
  await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeVisible();
  const card = page.getByRole("region", { name: "Aldric's work on Tidy the notes" });
  await expect(card).toContainText("Aldric finished this", { timeout: 30_000 });
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeHidden({ timeout: 30_000 });

  await card.getByRole("button", { name: "Open in Workbench" }).click();
  const bench = page.getByRole("region", { name: "Workbench for Tidy the notes" });
  const open = bench.getByRole("tabpanel", { name: /^Summary/ }).getByRole("region", { name: "Still open" });
  await expect(open.getByRole("alert")).toHaveText(
    "Hobbots could not read what is still open, so something may still be waiting.Try again",
    { timeout: 20_000 },
  );
  await expect(open).not.toContainText("Nothing is waiting on you or anyone else.");

  failing = false;
  await open.getByRole("button", { name: "Try again" }).click();
  await expect(open).toContainText("Nothing is waiting on you or anyone else.");
  await expect(open.getByRole("alert")).toBeHidden();
});
