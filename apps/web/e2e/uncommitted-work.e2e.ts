import { expect, test } from "./hub.ts";
import { questHub, stopQuestHub } from "./quest-hub.ts";
import { openQuest, taskSheet } from "./work-sheet.ts";

test.afterEach(stopQuestHub);

// Issue #586: Quill finishes the shop badge with the badge's file left uncommitted, and the
// Workbench Summary keeps it under Still open.

// covers OR-004
test("[TC-OR-288] a Task that completed with uncommitted changes shows them under Still open in its Summary", async ({
  page,
}) => {
  const { url, aldric } = await questHub();
  await page.goto(`${url}/#/hobs/${aldric}/new`);
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  await composer.fill("Make the shop badge in our green");
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeVisible();

  const room = await openQuest(page, "Make the shop badge");
  const badge = room.getByRole("button", { name: /Quill · Make the shop badge/ });
  await expect(badge).toContainText("Done", { timeout: 15_000 });
  await badge.click();
  await taskSheet(page, "Make the shop badge").getByRole("button", { name: "Open Workbench" }).click();

  const bench = page.getByRole("region", { name: "Workbench for Make the shop badge" });
  const open = bench.getByRole("tabpanel", { name: /^Summary/ }).getByRole("region", { name: "Still open" });
  await expect(open).toContainText("Uncommitted changes");
  await expect(open).toContainText("Left 1 file uncommitted since the last commit: web/badge.png in /fake/shop.");
  await expect(open).not.toContainText("Nothing is waiting on you or anyone else.");
});

// Issue #665: Aldric completes the Quest he leads with the spec he edited left uncommitted, and
// says why, so the top Task's own Summary keeps the file under Still open.

// covers OR-004
test("[TC-OR-462] a Quest whose lead left a file uncommitted shows it under Still open in the top Task's Summary", async ({
  page,
}) => {
  const { url, aldric } = await questHub();
  await page.goto(`${url}/#/hobs/${aldric}/new`);
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  await composer.fill("Wrap up the spec for the shop");
  await composer.press("Enter");

  // Aldric brings nobody in, so Details on his card opens his own Task.
  const card = page.getByRole("region", { name: "Aldric's work on Wrap up the spec" });
  await expect(card).toContainText("Aldric finished this", { timeout: 15_000 });
  await card.getByRole("button", { name: "Open the task" }).click();
  await taskSheet(page, "Wrap up the spec").getByRole("button", { name: "Open Workbench" }).click();

  const bench = page.getByRole("region", { name: "Workbench for Wrap up the spec" });
  const open = bench.getByRole("tabpanel", { name: /^Summary/ }).getByRole("region", { name: "Still open" });
  await expect(open).toContainText("Uncommitted changes");
  await expect(open).toContainText("Left 1 file uncommitted since the last commit: docs/SPEC.md in /fake/shop.");
  await expect(open).toContainText("Left on purpose: You asked to review it before it is committed.");
});
