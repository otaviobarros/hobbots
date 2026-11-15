import type { Page } from "@playwright/test";
import { expect, test } from "./hub.ts";
import { openWorkbench, taskSummary, ticket } from "./quest-sheet.ts";
import { aldricHub, script, stopAldricHub } from "./workbench-hub.ts";

test.afterEach(stopAldricHub);

/** The chat's thread, from the page's address once the first message made it. */
const threadOf = (page: Page) => /\/threads\/([^/?]+)/.exec(page.url())?.[1];

/**
 * Sends one message to Aldric and waits until his reply to it is complete. The hub may wake him
 * first on its own, when his last turn left the Quest with nothing moving it (#1081): the message
 * then waits for that turn, so the Stop button alone does not tell whose turn ended. The fake echoes
 * the long brief of each turn word by word, so each takes seconds.
 */
const send = async (page: Page, lines: ReadonlyArray<string>) => {
  const content = lines.join("\n");
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  await composer.fill(content);
  await expect(page.getByRole("button", { name: /^Send( after this reply)?$/ })).toBeEnabled();
  await composer.press("Enter");
  await expect(composer).toHaveValue("");
  await expect
    .poll(
      async () => {
        const thread = threadOf(page);
        if (thread === undefined) return false;
        const messages = (await (
          await page.request.get(`${new URL(page.url()).origin}/api/threads/${thread}/messages`)
        ).json()) as ReadonlyArray<{
          id: string;
          role: string;
          content: string;
          status: string;
          promptId: string | null;
        }>;
        const asked = messages.find((message) => message.role === "user" && message.content === content);
        return messages.some(
          (message) => message.role === "assistant" && message.promptId === asked?.id && message.status === "complete",
        );
      },
      { timeout: 60_000 },
    )
    .toBe(true);
};

test("the lead's later turns on its Task stay in Attempt 1, and its Workbench keeps what each turn changed", async ({
  page,
}) => {
  // Three sends, each of which may wait for one turn ahead of its own.
  test.setTimeout(150_000);
  const { url, aldric } = await aldricHub();
  await page.goto(`${url}/#/hobs/${aldric}/chat`);

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
  await send(page, [
    "Wrap it up",
    script("complete_task", { delivered: true, key: "done", summary: "The notes are tidy." }),
  ]);
  const questTicket = ticket(page, "Tidy the notes");
  await expect(questTicket).toContainText("Finished in", { timeout: 30_000 });

  // The hub kept one Attempt of the Task for all three turns, completed once the last turn ended.
  const attempts = async () => {
    const read = await page.request.get(`${url}/api/threads/${threadOf(page)}/tasks`);
    const { trees } = (await read.json()) as {
      trees: ReadonlyArray<{
        tasks: ReadonlyArray<{ id: string }>;
        attempts: ReadonlyArray<{ taskId: string; number: number; state: string }>;
      }>;
    };
    const top = trees[0]?.tasks[0]?.id;
    return trees[0]?.attempts
      .filter((attempt) => attempt.taskId === top)
      .map(({ number, state }) => ({ number, state }));
  };
  await expect.poll(attempts).toEqual([{ number: 1, state: "completed" }]);

  // Its Workbench offers no Attempt to pick, and its lane's summary shows what both turns changed.
  await openWorkbench(page, questTicket);
  const bench = page.getByRole("region", { name: "Workbench for Tidy the notes" });
  await expect(bench.getByRole("heading", { name: "Tidy the notes" })).toBeVisible();
  await expect(bench.getByRole("radiogroup", { name: "Attempts" })).toHaveCount(0);
  const made = (await taskSummary(page, "Tidy the notes")).getByRole("region", { name: "What it made" });
  await expect(made.getByRole("button", { name: /^See the change to / })).toHaveText([
    /^Added.*CHANGELOG\.md$/,
    /^Edited.*notes\.md$/,
  ]);
});
