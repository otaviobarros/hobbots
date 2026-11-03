import { expect, test } from "./hub.ts";
import { aldricHub, script, stopAldricHub } from "./workbench-hub.ts";

// Issue #667 in the browser: a step that stops on a finding, with no result, shows as blocked with
// the finding on the Task card, and the step after it waits. The hub side is checked in
// apps/server/test/stopped-steps.test.ts.

test.afterEach(stopAldricHub);

const FINDING = "The README and SPEC are already there from an earlier run";

// covers OR-002, OR-004, UX-002
test("[TC-OR-402] the Task card shows a step that stopped on a finding as blocked, and the step after it waits", async ({
  page,
}) => {
  const { url, aldric } = await aldricHub();
  await page.goto(`${url}/#/hobs/${aldric}/new`);
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  const steps = [
    {
      brief: `Write the README and SPEC\n${script("report_checkpoint", { key: "found", kind: "finding", summary: FINDING })}`,
    },
    { brief: `Write the notes\n${script("complete_task", { key: "notes", summary: "Notes written" })}`, after: [1] },
  ];
  await composer.fill(["Write the docs", script("plan_steps", { key: "plan", steps })].join("\n"));
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeVisible();

  // Step 1 needs Aldric: blocked, with what it found, not done.
  const card = page.getByRole("region", { name: "Aldric's work on Write the docs" });
  const row = card.getByRole("button", { name: "Look inside Write the README and SPEC" });
  await expect(row).toContainText("Blocked", { timeout: 20_000 });
  await expect(row).toContainText("step 1 of 2");
  await expect(card).toContainText("0 of 2 done");
  await row.click();
  await expect(page.getByRole("complementary", { name: "Write the README and SPEC, Task details" })).toContainText(
    FINDING,
  );

  // Step 2 waits on it, and never ran.
  await page.getByRole("tab", { name: "Quest" }).click();
  const tasks = page.getByRole("list", { name: "Tasks of Write the docs" });
  const notes = tasks.getByRole("button", { name: /Write the notes/ });
  await expect(notes).toContainText("Waiting");
  await expect(tasks.getByRole("button", { name: /Write the README and SPEC/ })).toContainText("Blocked");
});
