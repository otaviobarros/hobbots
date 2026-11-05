import { expect, test } from "./hub.ts";
import { openWorkbench, taskSummary, ticket } from "./quest-room.ts";
import { aldricHub, script, stopAldricHub } from "./workbench-hub.ts";

test.afterEach(stopAldricHub);

// covers OR-007, UX-002
test("[TC-OR-306] a Task tool call the hub refused shows as a failed step in the reply and in its lane's summary", async ({
  page,
}) => {
  const { url, aldric } = await aldricHub();
  await page.goto(`${url}/#/hobs/${aldric}/new`);
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  // Aldric starts the Task, then tries to hand part of it to a hob that does not exist.
  await composer.fill(
    [
      "Tidy the notes",
      script("start_quest", { key: "quest", goal: "Tidy the notes" }),
      script("delegate_task", { key: "nobody", hob: "Nobody", brief: "Tidy half of them" }),
    ].join("\n"),
  );
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeVisible();
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeHidden({ timeout: 30_000 });

  // The reply's step says it failed, and why, in plain words.
  const steps = page.getByRole("list", { name: "Reply steps" }).last();
  const refusedStep = steps.getByRole("listitem").filter({ hasText: "Delegating a Task" });
  await expect(refusedStep).toHaveAttribute("data-state", "failed");
  await expect(refusedStep).toContainText("failed");
  await expect(refusedStep).toContainText("Hobbots refused this: There is no hob named Nobody.");
  await expect(steps.getByRole("listitem").filter({ hasText: "Starting a Quest" })).toHaveAttribute(
    "data-state",
    "done",
  );

  // The summary in the Task's lane shows it under What happened, as failed, with what Aldric was told.
  await openWorkbench(page, ticket(page, "Tidy the notes"));
  const summary = await taskSummary(page, "Tidy the notes");
  const refused = summary.locator('[data-slot="refused-call"]');
  await expect(refused).toHaveCount(1);
  await expect(refused).toContainText("Failed");
  await expect(refused).toContainText("Delegating a Task: refused");
  await expect(refused).toContainText("Hobbots told Aldric: There is no hob named Nobody.");
});
