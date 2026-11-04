import type { Page } from "@playwright/test";
import { expect, test } from "./hub.ts";
import { aldricHub, script, stopAldricHub } from "./workbench-hub.ts";

test.afterEach(stopAldricHub);

/** Sends one message to Aldric and waits for his turn to end. */
const send = async (page: Page, lines: ReadonlyArray<string>) => {
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  await composer.fill(lines.join("\n"));
  await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeVisible();
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeHidden({ timeout: 30_000 });
};

// covers EX-001, OR-003, UX-002
test("[TC-OR-315] the lead's later turns on its Task stay in Attempt 1, and its Workbench keeps what each turn changed", async ({
  page,
}) => {
  const { url, aldric } = await aldricHub();
  await page.goto(`${url}/#/hobs/${aldric}/new`);

  // Three turns on one Task: the first starts it and edits the notes, the next reports a finding
  // and writes a changelog, the last finishes it.
  await send(page, [
    "Tidy the notes",
    script("start_quest", { key: "quest", goal: "Tidy the notes" }),
    'fake:write notes.md "# Notes\\n\\nTidied.\\n"',
  ]);
  await send(page, [
    "Now add a changelog",
    'fake:write CHANGELOG.md "## 1.0.0\\n"',
    script("report_checkpoint", { key: "found", kind: "finding", summary: "The notes needed a changelog." }),
  ]);
  await send(page, ["Wrap it up", script("complete_task", { key: "done", summary: "The notes are tidy." })]);
  const card = page.getByRole("region", { name: "Aldric's work on Tidy the notes" });
  await expect(card).toContainText("Aldric finished this", { timeout: 30_000 });

  // The hub kept one Attempt of the Task for all three turns.
  const thread = /\/threads\/([^/?]+)/.exec(page.url())?.[1];
  const read = await page.request.get(`${url}/api/threads/${thread}/tasks`);
  const { trees } = (await read.json()) as {
    trees: ReadonlyArray<{
      tasks: ReadonlyArray<{ id: string }>;
      attempts: ReadonlyArray<{ taskId: string; number: number; state: string }>;
    }>;
  };
  const top = trees[0]?.tasks[0]?.id;
  expect(trees[0]?.attempts.filter((attempt) => attempt.taskId === top)).toMatchObject([
    { number: 1, state: "completed" },
  ]);

  // Its Workbench offers no Attempt to pick, and shows what both turns changed.
  await card.getByRole("button", { name: "Open in Workbench" }).click();
  const bench = page.getByRole("region", { name: "Workbench for Tidy the notes" });
  await expect(bench.getByRole("heading", { name: "Tidy the notes" })).toBeFocused();
  await expect(bench.getByRole("radiogroup", { name: "Attempts" })).toHaveCount(0);
  const made = bench.getByRole("tabpanel", { name: /^Summary/ }).getByRole("region", { name: "What it made" });
  await expect(made.getByRole("button", { name: /^See the change to / })).toHaveText([
    /^Added.*CHANGELOG\.md$/,
    /^Edited.*notes\.md$/,
  ]);
});
