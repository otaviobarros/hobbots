import { expect, test } from "./hub.ts";
import { questHub, stopQuestHub } from "./quest-hub.ts";
import { laneHead, openRoom, showInWorkbench, ticket } from "./quest-room.ts";

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

  await openRoom(page, "Make the shop badge");
  await expect(laneHead(page, "Quill")).toContainText("Done", { timeout: 15_000 });
  const bench = await showInWorkbench(page, "Make the shop badge", "Quill");
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

  // Aldric brings nobody in, so his ticket opens a room with his lane alone.
  const questTicket = ticket(page, "Wrap up the spec");
  await expect(questTicket).toContainText("Finished in", { timeout: 15_000 });
  await openRoom(page, "Wrap up the spec");
  const bench = await showInWorkbench(page, "Wrap up the spec");
  const open = bench.getByRole("tabpanel", { name: /^Summary/ }).getByRole("region", { name: "Still open" });
  await expect(open).toContainText("Uncommitted changes");
  await expect(open).toContainText("Left 1 file uncommitted since the last commit: docs/SPEC.md in /fake/shop.");
  await expect(open).toContainText("Left on purpose: You asked to review it before it is committed.");
});
