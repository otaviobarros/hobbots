import { expect, test } from "./hub.ts";
import { openWorkbench, taskSummary, ticket } from "./quest-room.ts";
import { aldricHub, script, stopAldricHub } from "./workbench-hub.ts";

test.afterEach(stopAldricHub);

// covers OR-007, PE-005, UX-002
test("[TC-PE-425] a git_init the hub refused shows as a failed step in the reply and in its lane's summary", async ({
  page,
}) => {
  // Aldric's folder already holds a repository's `.git`, so creating a repository there is refused (#664).
  const { url, aldric, folder } = await aldricHub({ ".git/HEAD": "ref: refs/heads/main\n" });
  await page.goto(`${url}/#/hobs/${aldric}/new`);
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  await composer.fill(
    [
      "Tidy the notes",
      script("start_quest", { key: "quest", goal: "Tidy the notes" }),
      script("git_init", { folder }),
    ].join("\n"),
  );
  await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeVisible();
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeHidden({ timeout: 30_000 });

  // The reply's step says it failed, and why.
  const steps = page.getByRole("list", { name: "Reply steps" }).last();
  const refusedStep = steps.getByRole("listitem").filter({ hasText: "Creating a Git repository" });
  await expect(refusedStep).toHaveAttribute("data-state", "failed");
  await expect(refusedStep).toContainText(`Hobbots refused this: ${folder} is already a Git repository`);

  // The summary in the Task's lane shows it under What happened, as failed, with what Aldric was told.
  await openWorkbench(page, ticket(page, "Tidy the notes"));
  const summary = await taskSummary(page, "Tidy the notes");
  const refused = summary.locator('[data-slot="refused-call"]');
  await expect(refused).toHaveCount(1);
  await expect(refused).toContainText("Failed");
  await expect(refused).toContainText("git_init: refused");
  await expect(refused).toContainText(`Hobbots told Aldric: ${folder} is already a Git repository`);
});
