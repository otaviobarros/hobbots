import { expect, test } from "./hub.ts";
import { lane, laneMenu, laneTask, openRoom, taskSummary } from "./quest-room.ts";
import { aldricHub, script, stopAldricHub } from "./workbench-hub.ts";

// Issue #892 in the browser: a planned step's turn runs outside any chat, so the summary in its lane
// is where its tool calls show, as they happen and after they end. The hub side is checked in
// apps/server/test/session-steps.test.ts.

test.afterEach(stopAldricHub);

const TITLE = "Tidy the notes file";

// covers UX-002, EX-004
test("[TC-UX-165] a step's summary in its lane shows its tool calls live, a refused one with why, and keeps them ended after a reload", async ({
  page,
}) => {
  const { url, aldric } = await aldricHub();
  await page.goto(`${url}/#/hobs/${aldric}/new`);
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  // The step edits the notes, tries a write it may not make, then starts a job that keeps running.
  const brief = [
    TITLE,
    'fake:write notes.md "# Notes\\n\\nTidied.\\n"',
    "fake:tool Write /etc/hobbots-e2e.txt",
    "fake:tool Bash sleep 600",
  ].join("\n");
  await composer.fill(["Tidy the notes", script("plan_steps", { key: "plan", steps: [{ brief }] })].join("\n"));
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  await composer.press("Enter");

  await openRoom(page, "Tidy the notes");
  const sheet = laneTask(page, TITLE);
  await expect(sheet).toContainText("Running", { timeout: 30_000 });
  const happened = (await taskSummary(page, TITLE)).getByRole("region", { name: "What happened" });
  const tools = happened.locator('[data-slot="tool-step"]');

  // While the turn runs, each call shows as it ends, and the job as still running.
  await expect(tools).toHaveText(
    [
      /^✓DoneWriting notes\.md$/,
      /^✕FailedWriting hobbots-e2e\.txt\s*Why: \/etc\/hobbots-e2e\.txt is outside this hob's folders\.$/,
      /^●WorkingRunning sleep 600$/,
    ],
    { timeout: 30_000 },
  );

  // Cancelled, the job it cut off is marked as unresolved, never as done.
  await (await laneMenu(page, "Aldric")).getByRole("menuitem", { name: "Cancel a step…" }).click();
  const lead = lane(page, "Aldric");
  await lead.getByRole("button", { name: "Yes, cancel" }).click();
  await expect(lead.getByRole("status").filter({ hasText: "Cancelled: the task confirmed it stopped." })).toBeVisible({
    timeout: 30_000,
  });
  const ended = [
    /^✓DoneWriting notes\.md$/,
    /^✕FailedWriting hobbots-e2e\.txt\s*Why: \/etc\/hobbots-e2e\.txt is outside this hob's folders\.$/,
    /^!.*Running sleep 600/,
  ];
  await expect(tools).toHaveText(ended);

  // The steps are kept on the Attempt, so a fresh page load shows them ended the same way.
  await page.reload();
  await taskSummary(page, TITLE);
  await expect(tools).toHaveText(ended);
});
