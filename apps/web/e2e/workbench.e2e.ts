import { join } from "node:path";
import { expect, test } from "./hub.ts";
import { aldricHub, script, stopAldricHub } from "./workbench-hub.ts";

test.afterEach(stopAldricHub);

// covers UX-002, UX-006
test("[TC-UX-021] a finished Task's Workbench opens on Summary, greys out the Terminal it did not use and goes back to the same chat", async ({
  page,
}) => {
  const { url, aldric } = await aldricHub();
  await page.goto(`${url}/#/hobs/${aldric}/new`);
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  // In one turn Aldric edits a file with a file tool, runs no command and finishes the Task.
  await composer.fill(
    [
      "Tidy the notes",
      'fake:write notes.md "# Notes\\n\\nTidied.\\n"',
      script("start_quest", { key: "quest", goal: "Tidy the notes" }),
      script("complete_task", { key: "done", summary: "The notes are tidy." }),
    ].join("\n"),
  );
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeVisible();
  const card = page.getByRole("region", { name: "Aldric's work on Tidy the notes" });
  await expect(card).toContainText("Aldric finished this", { timeout: 30_000 });
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeHidden({ timeout: 30_000 });

  // Pinned, and with a message left unsent, the Workbench opens from the card in the chat's place.
  await page.getByRole("tab", { name: "Quest" }).click();
  const room = page.getByRole("region", { name: "Control room for Tidy the notes" });
  await room.getByRole("button", { name: "Pin" }).click();
  await composer.fill("A thought for later");
  await card.getByRole("button", { name: "Open in Workbench" }).click();
  const bench = page.getByRole("region", { name: "Workbench for Tidy the notes" });
  await expect(bench.getByRole("heading", { name: "Tidy the notes" })).toBeFocused();
  // One History tag for the finished Attempt, in the header.
  await expect(bench.locator("header").first()).toContainText("History");
  await expect(bench).toContainText("Aldric·asked by You");
  await expect(bench).toContainText("Claude Code");
  await expect(composer).toBeHidden();

  // Summary opens first; a tab the Task did not use is greyed out but opens and says so.
  const tabs = bench.getByRole("tablist", { name: "Workbench views" });
  await expect(tabs.getByRole("tab")).toHaveText([
    "Summary",
    "Changes",
    "Files",
    "TerminalNot used in this task",
    "BrowserSoon",
  ]);
  const summary = tabs.getByRole("tab", { name: /^Summary/ });
  await expect(summary).toHaveAttribute("aria-selected", "true");
  await expect(bench.getByRole("tabpanel", { name: /^Summary/ })).toBeVisible();

  // The arrow keys move between the tabs; each opens, the Terminal and the Browser saying why.
  await summary.focus();
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

  // Escape goes back to the same chat, with the message still unsent and the Quest still pinned.
  await page.keyboard.press("Escape");
  await expect(bench).toBeHidden();
  await expect(composer).toHaveValue("A thought for later");
  await expect(room.getByRole("button", { name: "Pin" })).toHaveAttribute("aria-pressed", "true");

  // Opened again it starts on Summary.
  await card.getByRole("button", { name: "Open in Workbench" }).click();
  await expect(bench.getByRole("tab", { name: /^Summary/ })).toHaveAttribute("aria-selected", "true");
  await bench.getByRole("button", { name: "← Back to chat" }).click();
  await expect(bench).toBeHidden();
});

// covers UX-002, UX-006
test("[TC-UX-022] the Workbench opens from the Task drawer and the Quest tab, and goes back to the drawer it came from with its unsent note", async ({
  page,
}) => {
  const { url, aldric } = await aldricHub();
  await page.goto(`${url}/#/hobs/${aldric}/new`);
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  await composer.fill(["Tidy the notes", script("start_quest", { key: "quest", goal: "Tidy the notes" })].join("\n"));
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeVisible();
  const card = page.getByRole("region", { name: "Aldric's work on Tidy the notes" });
  await expect(card).toBeVisible({ timeout: 20_000 });

  // From the drawer, Back to the task reopens the drawer with its unsent note.
  await card.getByRole("button", { name: "Show details" }).click();
  const drawer = page.getByRole("complementary", { name: "Tidy the notes, Task details" });
  const note = drawer.getByRole("textbox", { name: "Tell Aldric about this task" });
  await note.fill("Keep the headings short");
  await drawer.getByRole("button", { name: "Open in Workbench" }).click();
  const bench = page.getByRole("region", { name: "Workbench for Tidy the notes" });
  await expect(bench).toBeVisible();
  await expect(drawer).toBeHidden();
  await bench.getByRole("button", { name: "← Back to the task" }).click();
  await expect(drawer).toBeVisible();
  await expect(note).toHaveValue("Keep the headings short");

  // From the Quest tab, the open Task's controls open its Workbench.
  await page.getByRole("tab", { name: "Quest" }).click();
  const controls = page.getByRole("region", { name: "Controls for Tidy the notes" });
  await controls.getByRole("button", { name: "Open in Workbench" }).click();
  await expect(bench).toBeVisible();
  await expect(bench.getByRole("tab", { name: /^Summary/ })).toHaveAttribute("aria-selected", "true");
});

// covers UX-002, IN-004
test("[TC-UX-050] a nudge from the Workbench chat reaches Aldric as a note on the Task, and his next turn reads it", async ({
  page,
}) => {
  const { url, aldric } = await aldricHub();
  await page.goto(`${url}/#/hobs/${aldric}/new`);
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  await composer.fill(["Tidy the notes", script("start_quest", { key: "quest", goal: "Tidy the notes" })].join("\n"));
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeVisible();
  const card = page.getByRole("region", { name: "Aldric's work on Tidy the notes" });
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeHidden({ timeout: 20_000 });

  // The chat drawer opens beside the tabs, in the address, with focus in it.
  await card.getByRole("button", { name: "Open in Workbench" }).click();
  const bench = page.getByRole("region", { name: "Workbench for Tidy the notes" });
  await bench.getByRole("button", { name: "Talk to Aldric" }).click();
  const chat = bench.getByRole("complementary", { name: "Talk about Tidy the notes" });
  await expect(chat.getByRole("heading", { name: "Talk to Aldric" })).toBeFocused();
  await expect(chat).toContainText("Nothing sent about this task yet.");
  await expect(chat).toContainText("Goes to Aldric as a note on this task.");
  await expect(page).toHaveURL(/chat=open/);
  const nudges = chat.getByRole("group", { name: "Quick nudges" });
  await expect(nudges.getByRole("button")).toHaveText(["Looks good", "Explain what you did", "Keep going"]);

  // One tap sends the nudge as a note, which shows under your notes.
  await nudges.getByRole("button", { name: "Explain what you did" }).click();
  await expect(chat.getByRole("status")).toHaveText("Sent “Explain what you did” to Aldric.");
  const notes = chat.getByRole("list", { name: "Your notes on this task" });
  await expect(notes).toContainText("Explain what you did");
  await expect(notes).toContainText("To Aldric");

  // Escape closes the chat first, then leaves the Workbench.
  await page.keyboard.press("Escape");
  await expect(chat).toBeHidden();
  await expect(bench.getByRole("button", { name: "Talk to Aldric" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(bench).toBeHidden();

  // Aldric's next turn reads the note as a message about this Task.
  await expect(page.getByText(/The user left a note about Task \S+: Explain what you did/)).toBeVisible({
    timeout: 20_000,
  });
});

// covers UX-002
test("[TC-UX-052] a finished Task's Workbench chat offers no nudges or note box, and sends you to the chat", async ({
  page,
}) => {
  const { url, aldric } = await aldricHub();
  await page.goto(`${url}/#/hobs/${aldric}/new`);
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  await composer.fill(
    [
      "Tidy the notes",
      script("start_quest", { key: "quest", goal: "Tidy the notes" }),
      script("complete_task", { key: "done", summary: "The notes are tidy." }),
    ].join("\n"),
  );
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeVisible();
  const card = page.getByRole("region", { name: "Aldric's work on Tidy the notes" });
  await expect(card).toContainText("Aldric finished this", { timeout: 30_000 });
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeHidden({ timeout: 30_000 });

  await card.getByRole("button", { name: "Open in Workbench" }).click();
  const bench = page.getByRole("region", { name: "Workbench for Tidy the notes" });
  await bench.getByRole("button", { name: "Talk to Aldric" }).click();
  const chat = bench.getByRole("complementary", { name: "Talk about Tidy the notes" });
  await expect(chat).toContainText("This work has ended. Tell Aldric in the chat instead.");
  await expect(chat.getByRole("group", { name: "Quick nudges" })).toHaveCount(0);
  await expect(chat.getByRole("textbox")).toHaveCount(0);

  // Hide the chat closes it, and the address forgets it.
  await bench.getByRole("button", { name: "Hide the chat" }).click();
  await expect(chat).toBeHidden();
  await expect(page).not.toHaveURL(/chat=open/);
});

// covers UX-002, UX-006
test("[TC-UX-053] a nudge whose reply was lost goes out once when tapped again, even after the chat was closed", async ({
  page,
}) => {
  const { url, aldric } = await aldricHub();
  await page.goto(`${url}/#/hobs/${aldric}/new`);
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  await composer.fill(["Tidy the notes", script("start_quest", { key: "quest", goal: "Tidy the notes" })].join("\n"));
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeVisible();
  const card = page.getByRole("region", { name: "Aldric's work on Tidy the notes" });
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeHidden({ timeout: 20_000 });

  // The hub takes the nudge, but its reply never reaches the page.
  let reached = 0;
  await page.route("**/api/tasks/*/notes", async (route) => {
    await route.fetch();
    reached += 1;
    await route.abort("connectionreset");
  });
  await card.getByRole("button", { name: "Open in Workbench" }).click();
  const bench = page.getByRole("region", { name: "Workbench for Tidy the notes" });
  const talk = bench.getByRole("button", { name: "Talk to Aldric" });
  await talk.click();
  const chat = bench.getByRole("complementary", { name: "Talk about Tidy the notes" });
  const keepGoing = chat.getByRole("group", { name: "Quick nudges" }).getByRole("button", { name: "Keep going" });
  await keepGoing.click();
  await expect(chat.getByRole("status")).toHaveText("Your note could not be sent. Try again.");
  expect(reached).toBe(1);

  // Closed and opened again, the same nudge goes out under the same key: the hub keeps it once.
  await page.unroute("**/api/tasks/*/notes");
  await bench.getByRole("button", { name: "Hide the chat" }).click();
  await expect(chat).toBeHidden();
  await talk.click();
  await keepGoing.click();
  await expect(chat.getByRole("status")).toHaveText("Sent “Keep going” to Aldric.");
  await expect(chat.getByRole("list", { name: "Your notes on this task" }).getByRole("listitem")).toHaveCount(1);
  await page.reload();
  await expect(
    page
      .getByRole("complementary", { name: "Talk about Tidy the notes" })
      .getByRole("list", { name: "Your notes on this task" })
      .getByRole("listitem"),
  ).toHaveCount(1);

  // Tapped once more after the hub had it, it is a new note.
  await page
    .getByRole("complementary", { name: "Talk about Tidy the notes" })
    .getByRole("button", { name: "Keep going" })
    .click();
  await expect(
    page
      .getByRole("complementary", { name: "Talk about Tidy the notes" })
      .getByRole("list", { name: "Your notes on this task" })
      .getByRole("listitem"),
  ).toHaveCount(2);
});

// covers UX-002, UX-006
test("[TC-UX-030] a finished Task's Summary says what was asked, what happened and what it made, and links each file into Changes and Files", async ({
  page,
}) => {
  const { url, aldric, folder } = await aldricHub();
  await page.goto(`${url}/#/hobs/${aldric}/new`);
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
        key: "done",
        summary: "The notes are tidy, and the report says what changed.",
        artifacts: [
          { kind: "file", label: "The report", value: report },
          { kind: "link", label: "The style guide", value: "https://example.com/style" },
        ],
      }),
    ].join("\n"),
  );
  await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeVisible();
  const card = page.getByRole("region", { name: "Aldric's work on Tidy the notes" });
  await expect(card).toContainText("Aldric finished this", { timeout: 30_000 });
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeHidden({ timeout: 30_000 });

  await card.getByRole("button", { name: "Open in Workbench" }).click();
  const bench = page.getByRole("region", { name: "Workbench for Tidy the notes" });
  const summary = bench.getByRole("tabpanel", { name: /^Summary/ });
  await expect(summary.getByRole("region", { name: "What you asked" })).toContainText("Tidy the notes");
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
  await expect(summary.getByRole("region", { name: "The result" })).toContainText(
    "The notes are tidy, and the report says what changed.",
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
  await bench.getByRole("tab", { name: /^Summary/ }).click();
  await expect(page).not.toHaveURL(/file=/);
  await made.getByRole("button", { name: "See The report in Files" }).click();
  await expect(bench.getByRole("tab", { name: /^Files/ })).toHaveAttribute("aria-selected", "true");
  expect(new URL(page.url().replace("/#/", "/")).searchParams.get("file")).toBe(report);
});

// covers UX-002, UX-006
test("[TC-UX-031] a question waiting for you shows under Still open, and Answer in the chat goes back to it", async ({
  page,
}) => {
  const { url, aldric } = await aldricHub();
  await page.goto(`${url}/#/hobs/${aldric}/new`);
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  await composer.fill(
    [
      "Tidy the notes",
      script("start_quest", { key: "quest", goal: "Tidy the notes" }),
      script("ask", { key: "ask", question: "Should the headings be short?" }),
    ].join("\n"),
  );
  await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeVisible();
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeHidden({ timeout: 30_000 });

  const asks = page.getByRole("region", { name: "Aldric asks you" });
  await expect(asks).toContainText("Should the headings be short?");
  await page
    .getByRole("region", { name: "Aldric's work on Tidy the notes" })
    .getByRole("button", { name: "Open in Workbench" })
    .click();
  const bench = page.getByRole("region", { name: "Workbench for Tidy the notes" });
  const open = bench.getByRole("tabpanel", { name: /^Summary/ }).getByRole("region", { name: "Still open" });
  await expect(open).toContainText("A question for you");
  await expect(open).toContainText("Should the headings be short?");
  await expect(
    bench.getByRole("tabpanel", { name: /^Summary/ }).getByRole("region", { name: "The result" }),
  ).toContainText("No result yet.");

  await open.getByRole("button", { name: "Answer in the chat" }).click();
  await expect(bench).toBeHidden();
  await expect(asks).toBeVisible();
});

// covers UX-002, UX-006
test("[TC-UX-032] a Quest pinned from another thread sends Answer in the chat to the thread its question is in", async ({
  page,
}) => {
  const { url, aldric } = await aldricHub();
  await page.goto(`${url}/#/hobs/${aldric}/new`);
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  await composer.fill(
    [
      "Tidy the notes",
      script("start_quest", { key: "quest", goal: "Tidy the notes" }),
      script("ask", { key: "ask", question: "Should the headings be short?" }),
    ].join("\n"),
  );
  await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeVisible();
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeHidden({ timeout: 30_000 });
  const asks = page.getByRole("region", { name: "Aldric asks you" });
  await expect(asks).toBeVisible();
  const questThread = new URL(page.url().replace("/#/", "/")).pathname;

  // Pinned, the Quest follows to another thread, where its Workbench opens over that thread's chat.
  await page.getByRole("tab", { name: "Quest" }).click();
  const room = page.getByRole("region", { name: "Control room for Tidy the notes" });
  await room.getByRole("button", { name: "Pin" }).click();
  await page.goto(`${url}/#/hobs/${aldric}/new`);
  await composer.fill("Something else");
  await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeVisible();
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeHidden({ timeout: 30_000 });
  await expect(room).toContainText("Pinned from another thread");
  await room.getByRole("button", { name: /^Aldric · Tidy the notes/ }).click();
  await page
    .getByRole("region", { name: "Controls for Tidy the notes" })
    .getByRole("button", { name: "Open in Workbench" })
    .click();
  const bench = page.getByRole("region", { name: "Workbench for Tidy the notes" });
  const open = bench.getByRole("tabpanel", { name: /^Summary/ }).getByRole("region", { name: "Still open" });
  await expect(open).toContainText("Should the headings be short?");

  // Answer in the chat opens the Quest's own thread, where the question waits.
  await open.getByRole("button", { name: "Answer in the chat" }).click();
  await expect(bench).toBeHidden();
  expect(new URL(page.url().replace("/#/", "/")).pathname).toBe(questThread);
  await expect(asks).toContainText("Should the headings be short?");
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
  await page.goto(`${url}/#/hobs/${aldric}/new`);
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  await composer.fill(
    [
      "Tidy the notes",
      script("start_quest", { key: "quest", goal: "Tidy the notes" }),
      script("complete_task", { key: "done", summary: "The notes are tidy." }),
    ].join("\n"),
  );
  await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeVisible();
  const card = page.getByRole("region", { name: "Aldric's work on Tidy the notes" });
  await expect(card).toContainText("Aldric finished this", { timeout: 30_000 });
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeHidden({ timeout: 30_000 });

  await card.getByRole("button", { name: "Open in Workbench" }).click();
  const bench = page.getByRole("region", { name: "Workbench for Tidy the notes" });
  const open = bench.getByRole("tabpanel", { name: /^Summary/ }).getByRole("region", { name: "Still open" });
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
  await page.goto(`${url}/#/hobs/${aldric}/new`);
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  // The step tidies the notes and then fails. Retried from the same brief, it does nothing this
  // time, and fails again.
  const steps = [
    {
      brief: ["Tidy the notes file", 'fake:once fake:write notes.md "# Notes\\n\\nTidied.\\n"', "fake:fail"].join("\n"),
    },
  ];
  await composer.fill(["Tidy the notes", script("plan_steps", { key: "plan", steps })].join("\n"));
  await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeVisible();

  await page.getByRole("tab", { name: "Quest" }).click();
  const room = page.getByRole("region", { name: "Control room for Tidy the notes" });
  const step = room.getByRole("button", { name: /^Aldric · Tidy the notes file/ });
  await expect(step).toContainText("Failed", { timeout: 30_000 });
  await step.click();
  const controls = room.getByRole("region", { name: "Controls for Tidy the notes file" });
  await controls.getByRole("button", { name: "Retry" }).click();
  await expect(controls).toContainText("Attempt 2", { timeout: 15_000 });
  await expect(step).toContainText("Failed", { timeout: 30_000 });

  // With no Attempt chosen, the Workbench settles on the first, which changed the notes.
  await controls.getByRole("button", { name: "Open in Workbench" }).click();
  const bench = page.getByRole("region", { name: "Workbench for Tidy the notes file" });
  const attempts = bench.getByRole("radiogroup", { name: "Attempts" });
  await expect(attempts.getByRole("radio", { name: "Attempt 1" })).toBeChecked();
  await expect(attempts.getByRole("radio", { name: "Attempt 2" })).not.toBeChecked();
  const summary = bench.getByRole("tabpanel", { name: /^Summary/ });
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
  await expect(made).toContainText("Aldric did not make or change anything in this attempt.");
});
