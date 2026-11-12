import { expect, test } from "./hub.ts";
import { laneTask, openQuest, taskDetails, ticket } from "./quest-sheet.ts";
import { aldricHub, script, stopAldricHub } from "./workbench-hub.ts";

// Issue #667 in the browser: a step that stops on a finding, with no result, shows as blocked with
// the finding in its lane, and the step after it is held with it. The hub side is checked in
// apps/server/test/stopped-steps.test.ts.

test.afterEach(stopAldricHub);

const FINDING = "The README and SPEC are already there from an earlier run";

// covers OR-002, OR-004, UX-002
test("[TC-OR-402] the Quest room shows a step that stopped on a finding as blocked, and the step after it held", async ({
  page,
}) => {
  const { url, aldric } = await aldricHub();
  await page.goto(`${url}/#/hobs/${aldric}/chat`);
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  const steps = [
    {
      brief: `Write the README and SPEC\n${script("report_checkpoint", { key: "found", kind: "finding", summary: FINDING })}`,
    },
    {
      brief: `Write the notes\n${script("complete_task", { delivered: true, key: "notes", summary: "Notes written" })}`,
      after: [1],
    },
  ];
  await composer.fill(["Write the docs", script("plan_steps", { key: "plan", steps })].join("\n"));
  await expect(page.getByRole("button", { name: /^Send( after this reply)?$/ })).toBeEnabled();
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeVisible();

  // Step 1 needs Aldric: blocked, with what it found, not done. The ticket counts both steps.
  await expect(ticket(page, "Write the docs")).toContainText("0 of 2 done");
  await openQuest(page, "Write the docs");
  await expect(laneTask(page, "Write the README and SPEC")).toContainText("Blocked", { timeout: 20_000 });
  await expect(await taskDetails(page, "Write the README and SPEC")).toContainText(FINDING);

  // Step 2 is held by it, and never ran.
  await expect(laneTask(page, "Write the notes")).toContainText("Blocked");
  await expect(laneTask(page, "Write the README and SPEC")).toContainText("Blocked");
});
