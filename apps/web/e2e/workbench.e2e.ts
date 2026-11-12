import { join } from "node:path";
import { campAt, expect, test } from "./hub.ts";
import {
  dock,
  lane,
  laneTask,
  openRoom,
  openWorkbench,
  questRoom,
  roomMenu,
  showInWorkbench,
  taskSummary,
  ticket,
} from "./quest-room.ts";
import { aldricHub, script, stopAldricHub } from "./workbench-hub.ts";

test.afterEach(stopAldricHub);

// covers UX-002, UX-006
test("[TC-UX-021] a finished Task's Workbench opens in the room on Changes, counts each tab, greys out the Terminal it did not use and keeps the same chat beside it", async ({
  page,
}) => {
  const { url, aldric } = await aldricHub();
  await page.goto(`${url}/#/hobs/${aldric}/chat`);
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  // In one turn Aldric edits a file with a file tool, runs no command and finishes the Task.
  await composer.fill(
    [
      "Tidy the notes",
      'fake:write notes.md "# Notes\\n\\nTidied.\\n"',
      script("start_quest", { key: "quest", goal: "Tidy the notes" }),
      script("complete_task", { delivered: true, key: "done", summary: "The notes are tidy." }),
    ].join("\n"),
  );
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeVisible();
  const questTicket = ticket(page, "Tidy the notes");
  await expect(questTicket).toContainText("Finished in", { timeout: 30_000 });
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeHidden({ timeout: 30_000 });

  // With a message left unsent, the Workbench opens from the ticket, docked in the room beside the chat.
  await composer.fill("A thought for later");
  await openWorkbench(page, questTicket);
  const bench = page.getByRole("region", { name: "Workbench for Tidy the notes" });
  await expect(bench.getByRole("heading", { name: "Tidy the notes" })).toBeVisible();
  // One History tag for the finished Attempt, in the header.
  await expect(bench.locator("header").first()).toContainText("History");
  await expect(bench).toContainText("Aldric·asked by You");
  await expect(bench).toContainText("Claude Code");
  await expect(composer).toHaveValue("A thought for later");

  // Changes opens first, each tab with how many records it lists; a tab the Task did not use is
  // greyed out but opens and says so.
  const tabs = bench.getByRole("tablist", { name: "Workbench views" });
  await expect(tabs.getByRole("tab")).toHaveText([
    "Changes1",
    "Files1",
    "TerminalNot used in this task",
    "BrowserSoon",
  ]);
  const changes = tabs.getByRole("tab", { name: /^Changes/ });
  await expect(changes).toHaveAttribute("aria-selected", "true");
  await expect(bench.getByRole("tabpanel", { name: /^Changes/ })).toBeVisible();

  // The arrow keys move between the tabs; each opens, the Terminal and the Browser saying why.
  await changes.focus();
  await page.keyboard.press("ArrowLeft");
  const browser = tabs.getByRole("tab", { name: /^Browser/ });
  await expect(browser).toBeFocused();
  await expect(bench.getByRole("tabpanel", { name: /^Browser/ })).toContainText(
    "Watching a hob use a browser comes in a later update.",
  );
  await page.keyboard.press("ArrowLeft");
  await expect(tabs.getByRole("tab", { name: /^Terminal/ })).toHaveAttribute("aria-selected", "true");
  await expect(bench.getByRole("tabpanel", { name: /^Terminal/ })).toContainText(
    "Aldric did not use the terminal in this task.",
  );
  await expect(page).toHaveURL(/tab=terminal/);

  // Close room gives the chat back its width, with the message still unsent.
  const room = questRoom(page, "Tidy the notes");
  await room.getByRole("button", { name: "Close room" }).click();
  await expect(bench).toBeHidden();
  await expect(composer).toHaveValue("A thought for later");

  // Opened again it starts on Changes.
  await openWorkbench(page, questTicket);
  await expect(bench.getByRole("tab", { name: /^Changes/ })).toHaveAttribute("aria-selected", "true");
  await room.getByRole("button", { name: "Close room" }).click();
  await expect(bench).toBeHidden();
});

// covers UX-002, UX-006
test("[TC-UX-022] the header's quest button opens the room, and a lane's Show in the Workbench opens its Changes in the dock", async ({
  page,
}) => {
  const { url, aldric } = await aldricHub();
  await page.goto(`${url}/#/hobs/${aldric}/chat`);
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  await composer.fill(["Tidy the notes", script("start_quest", { key: "quest", goal: "Tidy the notes" })].join("\n"));
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeVisible();
  const questTicket = ticket(page, "Tidy the notes");
  await expect(questTicket).toBeVisible({ timeout: 20_000 });

  // The quest button in the header opens the room with the Workbench folded under the lane.
  await composer.fill("Keep the headings short");
  await page
    .getByRole("region", { name: "Work in progress" })
    .getByRole("button", { name: /Tidy the notes/ })
    .click();
  const room = questRoom(page, "Tidy the notes");
  await expect(room).toBeVisible();
  const bench = dock(page);
  await expect(bench.getByRole("button", { name: "Open the Workbench" })).toHaveAttribute("aria-expanded", "false");

  // Show in the Workbench opens it on Changes, and the unsent message stays in the chat beside it.
  await showInWorkbench(page, "Tidy the notes");
  await expect(bench.getByRole("tab", { name: /^Changes/ })).toHaveAttribute("aria-selected", "true");
  await expect(composer).toHaveValue("Keep the headings short");
});

// covers UX-002, UX-006
test("[TC-UX-030] a finished Task's summary in its lane says what happened and what it made, and links each file into Changes and Files", async ({
  page,
}) => {
  const { url, aldric, folder } = await aldricHub();
  await page.goto(`${url}/#/hobs/${aldric}/chat`);
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  // In one turn Aldric edits the notes, writes a report, reports a finding and finishes with what it made.
  const report = join(folder, "report.md");
  await composer.fill(
    [
      "Tidy the notes",
      script("start_quest", { key: "quest", goal: "Tidy the notes" }),
      'fake:write notes.md "# Notes\\n\\nTidied.\\n"',
      'fake:write report.md "# What changed\\n"',
      script("report_checkpoint", { key: "found", kind: "finding", summary: "Two notes said the same thing." }),
      script("complete_task", {
        delivered: true,
        key: "done",
        summary: "The notes are tidy, and the report says what changed.",
        artifacts: [
          { kind: "file", label: "The report", value: report },
          { kind: "link", label: "The style guide", value: "https://example.com/style" },
        ],
      }),
    ].join("\n"),
  );
  await expect(page.getByRole("button", { name: /^Send( after this reply)?$/ })).toBeEnabled();
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeVisible();
  const questTicket = ticket(page, "Tidy the notes");
  await expect(questTicket).toContainText("Finished in", { timeout: 30_000 });
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeHidden({ timeout: 30_000 });

  await openWorkbench(page, questTicket);
  const bench = page.getByRole("region", { name: "Workbench for Tidy the notes" });
  const summary = await taskSummary(page, "Tidy the notes");
  // It leads with the result, then what happened.
  await expect(summary.getByText("The notes are tidy, and the report says what changed.")).toBeVisible();
  await expect(summary.getByRole("region", { name: "What happened" })).toContainText(
    "DoneTwo notes said the same thing.",
  );
  const made = summary.getByRole("region", { name: "What it made" });
  await expect(made.getByRole("link", { name: "https://example.com/style" })).toBeVisible();
  await expect(made.getByRole("button", { name: /^See the change to / })).toHaveText([
    /^Edited.*notes\.md$/,
    /^Added.*report\.md$/,
  ]);
  await expect(summary.getByRole("region", { name: "Still open" })).toContainText(
    "Nothing is waiting on you or anyone else.",
  );
  // The buttons at the end name the tabs it used; it ran no command, so none names the Terminal.
  await expect(summary.getByRole("navigation", { name: "Open the other views" }).getByRole("button")).toHaveText([
    "See the 2 changed files",
    "See the 2 files",
  ]);

  // Each file opens its tab on that file.
  await made.getByRole("button", { name: "See the change to notes.md in Changes" }).click();
  await expect(bench.getByRole("tab", { name: /^Changes/ })).toHaveAttribute("aria-selected", "true");
  await expect(page).toHaveURL(/tab=changes/);
  expect(new URL(page.url().replace("/#/", "/")).searchParams.get("file")).toBe(join(folder, "notes.md"));
  await bench.getByRole("tab", { name: /^Terminal/ }).click();
  await expect(page).not.toHaveURL(/file=/);
  await made.getByRole("button", { name: "See The report in Files" }).click();
  await expect(bench.getByRole("tab", { name: /^Files/ })).toHaveAttribute("aria-selected", "true");
  expect(new URL(page.url().replace("/#/", "/")).searchParams.get("file")).toBe(report);
});

// covers UX-002, UX-006
test("[TC-UX-031] a question waiting for you shows in the lane above the Workbench, not again under Still open", async ({
  page,
}) => {
  const { url, aldric } = await aldricHub();
  await page.goto(`${url}/#/hobs/${aldric}/chat`);
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  await composer.fill(
    [
      "Tidy the notes",
      script("start_quest", { key: "quest", goal: "Tidy the notes" }),
      script("ask", { key: "ask", question: "Should the headings be short?" }),
    ].join("\n"),
  );
  await expect(page.getByRole("button", { name: /^Send( after this reply)?$/ })).toBeEnabled();
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeVisible();
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeHidden({ timeout: 30_000 });

  const asks = page.getByRole("region", { name: "Aldric asks you" });
  await expect(asks).toContainText("Should the headings be short?");
  await openWorkbench(page, ticket(page, "Tidy the notes"));
  const summary = await taskSummary(page, "Tidy the notes");
  const open = summary.getByRole("region", { name: "Still open" });
  await expect(summary).toContainText("Aldric is waiting on your answer in this lane.");
  await expect(open).not.toContainText("Should the headings be short?");

  // The lane holds the question, with its answer box.
  const inLane = lane(page, "Aldric").getByRole("region", { name: "Aldric asks you" });
  await expect(inLane).toContainText("Should the headings be short?");
  await expect(inLane.getByRole("textbox", { name: "Your answer to Aldric" })).toBeVisible();
});

// covers UX-002, UX-006
test("[TC-UX-032] a Quest pinned from another thread holds its question in its lane there", async ({ page }) => {
  const { url, aldric, hub } = await aldricHub();
  await page.goto(`${url}/#/hobs/${aldric}/chat`);
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  await composer.fill(
    [
      "Tidy the notes",
      script("start_quest", { key: "quest", goal: "Tidy the notes" }),
      script("ask", { key: "ask", question: "Should the headings be short?" }),
    ].join("\n"),
  );
  await expect(page.getByRole("button", { name: /^Send( after this reply)?$/ })).toBeEnabled();
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeVisible();
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeHidden({ timeout: 30_000 });
  const asks = page.getByRole("region", { name: "Aldric asks you" });
  await expect(asks).toBeVisible();
  const questThread = new URL(page.url().replace("/#/", "/")).pathname;

  // Pinned, the Quest follows to another thread, where its room opens beside that thread's chat.
  const header = page.getByRole("region", { name: "Work in progress" }).getByRole("button", { name: /Tidy the notes/ });
  await header.click();
  const room = questRoom(page, "Tidy the notes");
  await roomMenu(page, "Tidy the notes");
  await page.getByRole("menuitem", { name: "Pin quest" }).click();
  await page.goto((await campAt({ url, headers: hub.headers }, aldric, "Something else")).url);
  await composer.fill("Something else");
  await expect(page.getByRole("button", { name: /^Send( after this reply)?$/ })).toBeEnabled();
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeVisible();
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeHidden({ timeout: 30_000 });
  await header.click();
  await expect(room).toContainText("Pinned from another thread");
  await expect(lane(page, "Aldric").getByRole("region", { name: "Aldric asks you" })).toContainText(
    "Should the headings be short?",
  );
  expect(new URL(page.url().replace("/#/", "/")).pathname).not.toBe(questThread);
});

// covers UX-002, UX-006
test("[TC-UX-033] Still open says nothing is open only once it could read what waits, and offers Try again when it could not", async ({
  page,
}) => {
  const { url, aldric } = await aldricHub();
  // Every read of the hobs' backpacks fails until the test lets them through.
  let failing = true;
  await page.route("**/api/backpack", (route) =>
    failing ? route.fulfill({ status: 500, body: "" }) : route.continue(),
  );
  await page.goto(`${url}/#/hobs/${aldric}/chat`);
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  await composer.fill(
    [
      "Tidy the notes",
      script("start_quest", { key: "quest", goal: "Tidy the notes" }),
      script("complete_task", { delivered: true, key: "done", summary: "The notes are tidy." }),
    ].join("\n"),
  );
  await expect(page.getByRole("button", { name: /^Send( after this reply)?$/ })).toBeEnabled();
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeVisible();
  const questTicket = ticket(page, "Tidy the notes");
  await expect(questTicket).toContainText("Finished in", { timeout: 30_000 });
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeHidden({ timeout: 30_000 });

  await openWorkbench(page, questTicket);
  const open = (await taskSummary(page, "Tidy the notes")).getByRole("region", { name: "Still open" });
  await expect(open.getByRole("alert")).toHaveText(
    "Hobbots could not read what is still open, so something may still be waiting.Try again",
    { timeout: 20_000 },
  );
  await expect(open).not.toContainText("Nothing is waiting on you or anyone else.");

  failing = false;
  await open.getByRole("button", { name: "Try again" }).click();
  await expect(open).toContainText("Nothing is waiting on you or anyone else.");
  await expect(open.getByRole("alert")).toBeHidden();
});

// covers UX-002, UX-006, OR-007
test("[TC-UX-034] a retried step's Workbench opens on the Attempt that did the work, past a retry that did nothing", async ({
  page,
}) => {
  const { url, aldric } = await aldricHub();
  await page.goto(`${url}/#/hobs/${aldric}/chat`);
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  // The step tidies the notes and then fails. Retried from the same brief, it does nothing this
  // time, and fails again.
  const steps = [
    {
      brief: ["Tidy the notes file", 'fake:once fake:write notes.md "# Notes\\n\\nTidied.\\n"', "fake:fail"].join("\n"),
    },
  ];
  await composer.fill(["Tidy the notes", script("plan_steps", { key: "plan", steps })].join("\n"));
  await expect(page.getByRole("button", { name: /^Send( after this reply)?$/ })).toBeEnabled();
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeVisible();

  await openRoom(page, "Tidy the notes");
  const sheet = laneTask(page, "Tidy the notes file");
  await expect(sheet).toContainText("Failed", { timeout: 30_000 });
  await lane(page, "Aldric")
    .getByRole("region", { name: "Aldric's task failed" })
    .getByRole("button", { name: "Retry" })
    .click();
  await expect(sheet).toContainText("attempt 2", { timeout: 15_000 });
  await expect(sheet).toContainText("Failed", { timeout: 30_000 });

  // With no Attempt chosen, the Workbench and the lane's summary settle on the first, which changed the notes.
  const bench = await showInWorkbench(page, "Tidy the notes file");
  const attempts = bench.getByRole("radiogroup", { name: "Attempts" });
  await expect(attempts.getByRole("radio", { name: "Attempt 1" })).toBeChecked();
  await expect(attempts.getByRole("radio", { name: "Attempt 2" })).not.toBeChecked();
  const summary = await taskSummary(page, "Tidy the notes file");
  const made = summary.getByRole("region", { name: "What it made" });
  await expect(made.getByRole("button", { name: "See the change to notes.md in Changes" })).toBeVisible();
  await expect(summary.getByRole("region", { name: "What happened" })).toContainText("This attempt failed.");
  await expect(page).not.toHaveURL(/attempt=/);

  // Choosing the retry shows it, with nothing made, and the choice stays in the address.
  await attempts.getByRole("radio", { name: "Attempt 2" }).click();
  await expect(attempts.getByRole("radio", { name: "Attempt 2" })).toBeChecked();
  await expect(page).toHaveURL(/attempt=/);
  await expect(made).toContainText("Aldric did not make or change anything in this attempt.");
  await page.reload();
  await expect(attempts.getByRole("radio", { name: "Attempt 2" })).toBeChecked();
  await taskSummary(page, "Tidy the notes file");
  await expect(made).toContainText("Aldric did not make or change anything in this attempt.");
});
