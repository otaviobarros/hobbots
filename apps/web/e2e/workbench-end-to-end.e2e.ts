import type { Page } from "@playwright/test";
import { expect, test } from "./hub.ts";
import { aldricHub, script, stopAldricHub } from "./workbench-hub.ts";

// Issue #391: the Workbench's done-when checks (ADR 023) in the browser, with the fake runtime. One
// Task is followed through every tab while its turn runs and again once it has ended, and a Task
// that used none of them greys out each one. The hub side of the same checks, on SQLite and
// PostgreSQL, is in apps/server/test/workbench-end-to-end.test.ts.

test.afterEach(stopAldricHub);

// Wide enough that the Changes and Files lists sit beside the file; under 720px a picker takes their place.
test.use({ viewport: { width: 1600, height: 900 } });

/** A fake command that really changes Aldric's folder: text to write, null to delete. */
const run = (input: object) => `fake:run ${JSON.stringify(input)}`;

/**
 * A line the fake writes back word by word after its work, one word every 40 ms, so the turn keeps
 * running for about thirty seconds once its commands and edits are done.
 */
const LONG_REPLY = Array.from({ length: 750 }, (_, i) => `word${i + 1}`).join(" ");

/** Sends a scripted turn and waits until it is underway. */
const send = async (page: Page, lines: ReadonlyArray<string>) => {
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  await composer.fill(lines.join("\n"));
  await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeVisible();
};

const tabsOf = (page: Page, title: string) => {
  const bench = page.getByRole("region", { name: `Workbench for ${title}` });
  const tabs = bench.getByRole("tablist", { name: "Workbench views" });
  const panel = (name: string) => bench.getByRole("tabpanel", { name: new RegExp(`^${name}`) });
  const open = async (name: string) => {
    await tabs.getByRole("tab", { name: new RegExp(`^${name}`) }).click();
    return panel(name);
  };
  return { bench, tabs, open };
};

// covers UX-002, UX-006, PE-005
test("[TC-UX-062] a Task that edits files and runs commands is followed through every tab while it runs, and read again as history once it ends", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const { url, aldric, folder } = await aldricHub({
    "notes.md": "# Release notes\n",
    "draft.txt": "An old draft.\n",
  });
  await page.goto(`${url}/#/hobs/${aldric}/new`);
  // The first turn starts the Task, so the next turn's work belongs to it.
  await send(page, [
    "Write the release notes",
    script("start_quest", { key: "quest", goal: "Write the release notes" }),
  ]);
  const card = page.getByRole("region", { name: "Aldric's work on Write the release notes" });
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeHidden({ timeout: 30_000 });

  // In the next turn Aldric edits the notes with a file tool, runs a command that adds the
  // changelog and deletes the draft, printing a token, and runs a test, then keeps writing.
  await send(page, [
    "Finish the notes",
    'fake:write notes.md "# Release notes\\n\\n- Faster search.\\n"',
    run({
      command: "npm run changelog",
      writes: { "CHANGELOG.md": "## 1.2.0\n\n- Faster search.\n", "draft.txt": null },
      output: "Wrote CHANGELOG.md\nusing ghp_0123456789abcdefghijklmnopqrstuvwxyzAB\n",
      exitCode: 0,
      live: true,
    }),
    run({ command: "npm test", output: "2 passed\n", exitCode: 0 }),
    LONG_REPLY,
  ]);
  await card.getByRole("button", { name: "Open in Workbench" }).click();
  const { bench, tabs, open } = tabsOf(page, "Write the release notes");

  // Live: the header says so once, every tab follows the running turn, and the Browser is still to come.
  await expect(bench.locator("header").first()).toContainText("●Live");
  await expect(tabs.getByRole("tab")).toHaveText(["Summary", "Changes", "Files", "Terminal", "BrowserSoon"]);
  await expect(tabs.getByRole("tab", { name: /^Summary/ })).toHaveAttribute("aria-selected", "true");

  const changes = await open("Changes");
  const changed = changes.getByRole("navigation", { name: "Changed files" });
  await expect(changed.getByRole("button")).toHaveText(
    [/^CHANGELOG\.mdAdded\+/, /^draft\.txtDeleted\+0 −/, /^notes\.mdEdited\+/],
    {
      timeout: 20_000,
    },
  );
  await changed.getByRole("button", { name: /^notes\.md/ }).click();
  const notes = changes.getByRole("article", { name: "notes.md" });
  await expect(notes.getByRole("region", { name: "After" }).getByRole("insertion")).toContainText("Faster search.");
  await expect(notes).toContainText("So far: this turn is still running, so this file may change again.");

  const terminal = await open("Terminal");
  const commands = terminal.getByRole("list", { name: "Commands" }).getByRole("listitem");
  await expect(commands).toHaveCount(2, { timeout: 20_000 });
  await expect(commands.nth(0)).toContainText("npm run changelog");
  await expect(commands.nth(0)).toContainText("Succeeded");
  await expect(commands.nth(0)).toContainText(folder);
  await expect(commands.nth(0)).toContainText("[redacted: GitHub token]");
  await expect(commands.nth(0)).not.toContainText("ghp_0123456789");
  await expect(commands.nth(1)).toContainText("npm test");
  await expect(commands.nth(1)).toContainText("2 passed");

  const files = await open("Files");
  const list = files.getByRole("navigation", { name: "Files from this task" });
  await expect(list.getByRole("region", { name: "Changed in this task" }).getByRole("button")).toHaveText([
    /^CHANGELOG\.mdAdded/,
    /^notes\.mdEdited/,
  ]);
  await list.getByRole("button", { name: /^CHANGELOG\.md/ }).click();
  await expect(
    files.getByRole("region", { name: "CHANGELOG.md" }).getByRole("heading", { name: "1.2.0" }),
  ).toBeVisible();

  const browser = await open("Browser");
  await expect(browser).toContainText("Watching a hob use a browser comes in a later update.");

  // History: once the turn ends, the header says so, with nothing any tab showed lost.
  await expect(bench.locator("header").first()).toContainText("History", { timeout: 60_000 });
  await expect(tabs.getByRole("tab")).toHaveText(["Summary", "Changes", "Files", "Terminal", "BrowserSoon"]);
  await open("Changes");
  await expect(changed.getByRole("button")).toHaveText([
    /^CHANGELOG\.mdAdded\+/,
    /^draft\.txtDeleted\+0 −/,
    /^notes\.mdEdited\+/,
  ]);
  await expect(notes).not.toContainText("So far");
  await changed.getByRole("button", { name: /^draft\.txt/ }).click();
  await expect(changes.getByRole("article", { name: "draft.txt" })).toContainText("An old draft.");
  await open("Terminal");
  await expect(terminal).toContainText("2 commands");
  await expect(terminal).toContainText("A record of what ran. You cannot type here.");
  await expect(terminal.getByRole("textbox")).toHaveCount(0);

  // Summary names what the turn changed and the tabs it used, each one click away.
  const summary = await open("Summary");
  await summary.getByRole("button", { name: "Details" }).click();
  await expect(summary.getByRole("region", { name: "What you asked" })).toContainText("Write the release notes");
  await expect(summary.getByRole("region", { name: "What it made" }).getByRole("button")).toHaveText([
    /^Added.*CHANGELOG\.md$/,
    /^Deleted.*draft\.txt$/,
    /^Edited.*notes\.md$/,
  ]);
  const views = summary.getByRole("navigation", { name: "Open the other views" });
  await expect(views.getByRole("button")).toHaveText([
    "See the 3 changed files",
    "See the 2 files",
    "See what ran in Terminal",
  ]);
  await views.getByRole("button", { name: "See what ran in Terminal" }).click();
  await expect(tabs.getByRole("tab", { name: /^Terminal/ })).toHaveAttribute("aria-selected", "true");

  // Going back leaves the Workbench for the chat, whose turn has ended.
  await bench.getByRole("button", { name: "← Back to chat" }).click();
  await expect(bench).toBeHidden();
  await expect(page.getByRole("textbox", { name: /^Message Aldric/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeHidden();
});

// covers UX-002, UX-006
test("[TC-UX-063] a Task that changed no file and ran no command greys out Changes, Files and Terminal, each saying so, and Browser reads Soon", async ({
  page,
}) => {
  const { url, aldric } = await aldricHub();
  await page.goto(`${url}/#/hobs/${aldric}/new`);
  await send(page, [
    "Suggest a name for the release",
    script("start_quest", { key: "quest", goal: "Suggest a name for the release" }),
    script("complete_task", { key: "done", summary: "Call it Lantern." }),
  ]);
  const card = page.getByRole("region", { name: "Aldric's work on Suggest a name for the release" });
  await expect(card).toContainText("Aldric finished this", { timeout: 30_000 });
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeHidden({ timeout: 30_000 });

  await card.getByRole("button", { name: "Open in Workbench" }).click();
  const { tabs, open } = tabsOf(page, "Suggest a name for the release");
  await expect(tabs.getByRole("tab")).toHaveText([
    "Summary",
    "ChangesNot used in this task",
    "FilesNot used in this task",
    "TerminalNot used in this task",
    "BrowserSoon",
  ]);
  const summary = await open("Summary");
  // Summary leads with the result.
  await expect(summary.getByText("Call it Lantern.")).toBeVisible();
  await expect(summary.getByRole("navigation", { name: "Open the other views" }).getByRole("button")).toHaveCount(0);

  // Each greyed-out tab still opens, and says in a sentence why it is empty.
  await expect(await open("Changes")).toContainText("Aldric did not change any files in this task.");
  await expect(await open("Files")).toContainText("Aldric did not make or touch any files in this task.");
  await expect(await open("Terminal")).toContainText("Aldric did not use the terminal in this task.");
  await expect(await open("Browser")).toContainText("Watching a hob use a browser comes in a later update.");
});
