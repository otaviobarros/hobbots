import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Page } from "@playwright/test";
import { expect, startHub, test } from "./hub.ts";
import { aldricHub, script, stopAldricHub } from "./workbench-hub.ts";

test.afterEach(stopAldricHub);

/** A PNG of one pixel, as small as an image gets. */
const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z/C/HgAGgwJ/lK3Q6wAAAABJRU5ErkJggg==",
  "base64",
);

/** A fake command that really changes Aldric's folder: text to write, null to delete. */
const run = (command: string, writes: Record<string, string | null>) =>
  `fake:run ${JSON.stringify({ command, writes, output: "done\n", exitCode: 0 })}`;

/** Sends a scripted turn and waits until it has ended. */
const playTurn = async (page: Page, lines: ReadonlyArray<string>) => {
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  await composer.fill(lines.join("\n"));
  await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeVisible();
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeHidden({ timeout: 30_000 });
};

/** Opens the Workbench of the Task on the chat's card, on its Changes tab. */
const openChanges = async (page: Page, title: string) => {
  const card = page.getByRole("region", { name: `Aldric's work on ${title}` });
  await card.getByRole("button", { name: "Open in Workbench" }).click();
  const bench = page.getByRole("region", { name: `Workbench for ${title}` });
  await bench.getByRole("tab", { name: /^Changes/ }).click();
  return { bench, panel: bench.getByRole("tabpanel", { name: /^Changes/ }) };
};

// covers UX-002, UX-006
test("[TC-UX-035] a finished Task's Changes show a document rendered with its changed parts marked, code as a diff, and each file marked added, edited or deleted", async ({
  page,
}) => {
  const { url, aldric } = await aldricHub({
    "notes.md": "# Notes\n\nMessy line.\n\nKept as is.\n\n[guide]: https://example.com/guide\n",
    "src/app.ts": 'export const greet = () => "hi";\nexport const count = 1;\n',
    "old.txt": "Nobody reads this.\n",
  });
  await page.goto(`${url}/#/hobs/${aldric}/new`);
  // In one turn Aldric edits the notes with a file tool, and a command rewrites the code, adds a
  // file and deletes another, as a formatter or a script would.
  await playTurn(page, [
    "Tidy the project",
    'fake:write notes.md "# Notes\\n\\nTidy line, as the [guide] says.\\n\\nKept as is.\\n\\n[guide]: https://example.com/guide\\n"',
    run("npm run tidy", {
      "src/app.ts": 'export const greet = () => "hello";\nexport const count = 1;\n',
      "src/new.ts": "export const fresh = true;\n",
      "old.txt": null,
    }),
    script("start_quest", { key: "quest", goal: "Tidy the project" }),
    script("complete_task", { key: "done", summary: "Tidied." }),
  ]);
  const { bench, panel } = await openChanges(page, "Tidy the project");
  await expect(bench.getByRole("tab", { name: /^Changes/ })).toHaveText("ChangesHistory");
  await expect(panel).toContainText("4 files changed: 1 added, 2 edited, and 1 deleted");

  // Each file is listed with how it changed; the first, the notes, shows first.
  const files = panel.getByRole("navigation", { name: "Changed files" });
  await expect(files.getByRole("button")).toHaveText([
    "notes.mdEdited",
    "old.txtDeleted",
    "app.tssrc/Edited",
    "new.tssrc/Added",
  ]);
  await expect(files.getByRole("button", { name: /^notes\.md/ })).toHaveAttribute("aria-pressed", "true");

  // The document is rendered before and after, the paragraph it replaced and the one it wrote marked.
  const notes = panel.getByRole("article", { name: "notes.md" });
  const before = notes.getByRole("region", { name: "Before" });
  const after = notes.getByRole("region", { name: "After" });
  await expect(before.getByRole("heading", { name: "Notes" })).toBeVisible();
  await expect(before.getByRole("deletion")).toHaveText("Removed:Messy line.");
  await expect(after.getByRole("insertion")).toContainText("Added:Tidy line, as the guide");
  // Each version renders whole, so a link still finds its definition elsewhere in the document.
  await expect(after.getByRole("insertion").getByRole("link", { name: /guide/ })).toBeVisible();
  await expect(after).toContainText("Kept as is.");
  // Its source is one click away, as a diff.
  await notes.getByRole("button", { name: "Source" }).click();
  await expect(notes.getByRole("region", { name: "Changes to notes.md" })).toContainText(
    "Tidy line, as the [guide] says.",
  );
  await expect(notes).toContainText("1 line added, 1 removed");

  // Code is a line diff, numbered on each side.
  await files.getByRole("button", { name: /^app\.ts/ }).click();
  const code = panel
    .getByRole("article", { name: "src/app.ts" })
    .getByRole("region", { name: "Changes to src/app.ts" });
  await expect(code.getByRole("row")).toHaveText([
    '1−Removed:export const greet = () => "hi";',
    '1+Added:export const greet = () => "hello";',
    "22 export const count = 1;",
  ]);

  // A deleted file shows what it held; an added one, what it holds now.
  await files.getByRole("button", { name: /^old\.txt/ }).click();
  await expect(panel.getByRole("article", { name: "old.txt" })).toContainText("0 lines added, 1 removed");
  await files.getByRole("button", { name: /^new\.ts/ }).click();
  await expect(panel.getByRole("article", { name: "src/new.ts" })).toContainText("export const fresh = true;");

  // Switching tabs keeps the file chosen.
  await bench.getByRole("tab", { name: /^Summary/ }).click();
  await bench.getByRole("tab", { name: /^Changes/ }).click();
  await expect(files.getByRole("button", { name: /^new\.ts/ })).toHaveAttribute("aria-pressed", "true");
});

// covers UX-002, UX-006
test("[TC-UX-036] Changes are Live while the turn runs, showing each file as the hob changes it, and read as History once it ends", async ({
  page,
}) => {
  const { url, aldric } = await aldricHub({ "notes.md": "# Notes\n" });
  await page.goto(`${url}/#/hobs/${aldric}/new`);
  // Aldric starts the Task in one turn; in the next he writes the notes and then runs a long
  // command, so the turn stays open while the Task's Attempt runs.
  await playTurn(page, ["Draft the notes", script("start_quest", { key: "quest", goal: "Draft the notes" })]);
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  await composer.fill(['fake:write notes.md "# Notes\\n\\nA first draft.\\n"', "fake:tool Bash sleep 120"].join("\n"));
  await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeVisible();

  const { bench, panel } = await openChanges(page, "Draft the notes");
  await expect(bench.getByRole("tab", { name: /^Changes/ })).toHaveText("ChangesLive");
  const notes = panel.getByRole("article", { name: "notes.md" });
  await expect(notes.getByRole("region", { name: "After" }).getByRole("insertion")).toHaveText("Added:A first draft.", {
    timeout: 20_000,
  });
  await expect(notes).toContainText("So far: this turn is still running, so this file may change again.");

  // Stopped, the turn ends: the end-of-turn compare settles the change and the tab reads History.
  await bench.getByRole("button", { name: "← Back to chat" }).click();
  await page.getByRole("button", { name: "■ Stop" }).click();
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeHidden({ timeout: 30_000 });
  await openChanges(page, "Draft the notes");
  await expect(bench.getByRole("tab", { name: /^Changes/ })).toHaveText("ChangesHistory", { timeout: 20_000 });
  await expect(notes.getByRole("region", { name: "After" })).toContainText("A first draft.");
  await expect(notes).not.toContainText("So far");
});

// covers UX-002, UX-006
test("[TC-UX-037] an image the Task deleted shows its earlier version, and one past the size limit says why it was not kept", async ({
  page,
}) => {
  const { url, aldric } = await aldricHub({
    "logo.png": PIXEL,
    // Past the 10 MiB kept for an image.
    "poster.png": new Uint8Array(11 * 1024 * 1024),
  });
  await page.goto(`${url}/#/hobs/${aldric}/new`);
  await playTurn(page, [
    "Clear out the images",
    run("npm run clean", { "logo.png": null, "poster.png": null }),
    script("start_quest", { key: "quest", goal: "Clear out the images" }),
    script("complete_task", { key: "done", summary: "Cleared." }),
  ]);
  const { panel } = await openChanges(page, "Clear out the images");
  const files = panel.getByRole("navigation", { name: "Changed files" });
  await expect(files.getByRole("button")).toHaveText(["logo.pngDeleted", "poster.pngDeleted"]);

  const logo = panel.getByRole("article", { name: "logo.png" }).getByRole("img", { name: "logo.png before" });
  await expect(logo).toBeVisible();
  await expect.poll(() => logo.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(1);

  await files.getByRole("button", { name: /^poster\.png/ }).click();
  const poster = panel.getByRole("article", { name: "poster.png" });
  await expect(poster).toContainText("Earlier version not kept: too large.");
  await expect(poster.getByRole("img")).toHaveCount(0);
});

// covers UX-002, UX-006
test("[TC-UX-038] past the retention window a Task's Changes keep their list and read Unavailable, with why, in place of each file's contents", async ({
  page,
}) => {
  const started = await aldricHub({ "notes.md": "# Notes\n" });
  await page.goto(`${started.url}/#/hobs/${started.aldric}/new`);
  await playTurn(page, [
    "Tidy the notes",
    'fake:write notes.md "# Notes\\n\\nTidied.\\n"',
    script("start_quest", { key: "quest", goal: "Tidy the notes" }),
    script("complete_task", { key: "done", summary: "Tidied." }),
  ]);
  const thread = new URL(page.url()).hash;

  // The hub clears the heavy details 30 days after the Task ends; here they are marked cleared while
  // it is stopped, as its retention sweep would, and it starts again on the same data.
  await started.hub.stop();
  const database = new DatabaseSync(join(started.dataDir, "hobbots.sqlite"));
  database.prepare("UPDATE attempt_file_changes SET details_cleared_at = ?").run(new Date().toISOString());
  database.close();
  const again = await startHub(started.dataDir);
  try {
    await page.goto(`${again.url}/${thread}`);
    const { bench, panel } = await openChanges(page, "Tidy the notes");
    await expect(bench.getByRole("tab", { name: /^Changes/ })).toHaveText("ChangesUnavailable");
    await expect(panel).toContainText("Details were cleared after 30 days.");
    await expect(panel.getByRole("navigation", { name: "Changed files" }).getByRole("button")).toHaveText([
      "notes.mdEdited",
    ]);
    await expect(panel.getByRole("article", { name: "notes.md" })).toContainText(
      "Earlier version not kept: details were cleared after 30 days.",
    );
  } finally {
    await again.stop();
  }
});
