import type { Page } from "@playwright/test";
import { expect, test } from "./hub.ts";
import { dock, laneHead, laneTask, openRoom, taskSummary } from "./quest-room.ts";
import { aldricHub, script, stopAldricHub } from "./workbench-hub.ts";

// Issue #907 in the browser: one Workbench docked under the lanes for the whole Quest. Changes and
// Files list every hob's work in one list, each row with its hob; a lane filters every tab; and a
// try picked for a lane's Task changes what the tabs show.

test.afterEach(stopAldricHub);

// Wide enough that the Changes and Files lists sit beside the file; under 720px a picker takes their place.
test.use({ viewport: { width: 1600, height: 900 } });

// A party's Quest runs two hobs' turns before the dock is looked at.
test.describe.configure({ timeout: 120_000 });

const TITLE = "Write the launch copy";

/** Sends Aldric a scripted turn that starts the Quest, edits the notes and hands Quill the copy. */
const startParty = async (page: Page, quillBrief: ReadonlyArray<string>) => {
  const { url, aldric, members, api, folder } = await aldricHub(undefined, ["Quill"]);
  await api("PATCH", `/agents/${members[0]}/permissions`, { ownFolders: [folder] });
  await page.goto(`${url}/#/hobs/${aldric}/new`);
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  await composer.fill(
    [
      TITLE,
      'fake:write notes.md "# Notes\\n\\nLaunch day.\\n"',
      script("start_quest", { key: "quest", goal: TITLE }),
      script("delegate_task", { key: "copy", hob: "Quill", brief: quillBrief.join("\n") }),
    ].join("\n"),
  );
  await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeVisible();
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeHidden({ timeout: 30_000 });
  return openRoom(page, TITLE);
};

/** The dock's Changes and Files lists. */
const lists = (page: Page) => {
  const bench = dock(page);
  return {
    bench,
    changes: bench.getByRole("tabpanel", { name: /^Changes/ }).getByRole("navigation", { name: "Changed files" }),
    files: bench
      .getByRole("tabpanel", { name: /^Files/ })
      .getByRole("navigation", { name: "Files the hobs made or changed" }),
  };
};

// covers UX-002, OR-001
test("[TC-UX-280] a party's Workbench lists every hob's changes and files in one list, each with its hob, and a lane filters every tab", async ({
  page,
}) => {
  await startParty(page, [
    "Draft the copy",
    'fake:write copy.md "# Copy\\n\\nHello.\\n"',
    script("complete_task", { key: "drafted", summary: "Drafted." }),
  ]);
  await expect(laneHead(page, "Quill")).toContainText("Done", { timeout: 30_000 });
  const { bench, changes, files } = lists(page);

  // Folded, the strip counts what each tab lists across the party.
  await expect(bench.getByRole("tab", { name: /^Changes/ })).toHaveText("Changes2");
  await expect(bench.getByRole("tab", { name: /^Files/ })).toHaveText("Files2");

  // Changes lists both hobs' files in one list, in the Quest's order, each saying whose it is.
  await bench.getByRole("tab", { name: /^Changes/ }).click();
  // Expand makes the open dock as tall as the room lets it be, and takes it back again.
  const expand = bench.getByRole("button", { name: "Make the Workbench as tall as it goes" });
  const before = (await bench.boundingBox())?.height ?? 0;
  await expand.click();
  await expect(expand).toHaveAttribute("aria-pressed", "true");
  await expect.poll(async () => (await bench.boundingBox())?.height ?? 0).toBeGreaterThan(before);
  await expand.click();
  await expect(expand).toHaveAttribute("aria-pressed", "false");
  await expect.poll(async () => (await bench.boundingBox())?.height ?? 0).toBe(before);
  await expect(changes.getByRole("button")).toHaveText([/^notes\.md, by Aldric/, /^copy\.md, by Quill/]);
  await changes.getByRole("button", { name: /^copy\.md/ }).click();
  await expect(
    bench.getByRole("tabpanel", { name: /^Changes/ }).getByRole("article", { name: "copy.md" }),
  ).toContainText("Hello.");

  // Each hob's label is named apart over the tab, since no lit Task's header names one.
  const labels = bench.getByRole("list", { name: "Each hob's work on this tab" });
  await expect(labels).toContainText("Aldric ·");
  await expect(labels).toContainText("Quill · History");

  // Files does the same across the hobs.
  await bench.getByRole("tab", { name: /^Files/ }).click();
  await expect(files.getByRole("button")).toHaveText([/^notes\.md, by Aldric/, /^copy\.md, by Quill/]);

  // Quill's lane filters every tab to her work, and says so on the strip.
  await laneHead(page, "Quill").click();
  await expect(bench.getByRole("button", { name: /^Quill only/ })).toBeVisible();
  await expect(files.getByRole("button")).toHaveText([/^copy\.md/]);
  await bench.getByRole("tab", { name: /^Changes/ }).click();
  await expect(changes.getByRole("button")).toHaveText([/^copy\.md/]);
  await expect(bench.getByRole("tab", { name: /^Terminal/ })).toHaveText("TerminalNot used in this task");

  // The chip shows everyone's work again.
  await bench.getByRole("button", { name: /^Quill only/ }).click();
  await expect(bench.getByRole("button", { name: /^Quill only/ })).toHaveCount(0);
  await expect(changes.getByRole("button")).toHaveCount(2);
});

// covers UX-002, OR-001, OR-007
test("[TC-UX-281] the Workbench follows the try picked for a lane's Task, and every other Task's latest that did work", async ({
  page,
}) => {
  // Quill writes the copy and fails; on her second try she changes nothing and finishes with a result.
  await startParty(page, ["Draft the copy", 'fake:once fake:write copy.md "# Copy\\n\\nHello.\\n"', "fake:fail"]);
  // A member's failed turn is handed to her again as a second try, which no longer carries the
  // brief's once-only write or its failure.
  const sheet = laneTask(page, "Draft the copy");
  await expect(sheet).toContainText("attempt 2", { timeout: 30_000 });
  await expect(laneHead(page, "Quill")).toContainText("Done", { timeout: 30_000 });
  const { bench, changes } = lists(page);

  // With no try picked, Quill's work is her latest try's, which finished with nothing changed.
  await bench.getByRole("tab", { name: /^Changes/ }).click();
  await expect(changes.getByRole("button")).toHaveText([/^notes\.md, by Aldric/]);

  // Lit, her lane's Task names its tries, the latest checked: it changed nothing.
  await laneHead(page, "Quill").click();
  const attempts = bench.getByRole("radiogroup", { name: "Attempts" });
  await expect(attempts.getByRole("radio", { name: "Attempt 2" })).toBeChecked();
  await expect(bench.getByRole("tab", { name: /^Changes/ })).toHaveText("ChangesNot used in this task");
  await expect(bench.getByRole("tabpanel", { name: /^Changes/ })).toContainText(
    "Quill did not change any files in this task.",
  );
  await bench.getByRole("tab", { name: /^Files/ }).click();
  await expect(bench.getByRole("tabpanel", { name: /^Files/ })).toContainText(
    "Quill did not make or touch any files in this task.",
  );

  // Picking the first try changes every tab, and the address keeps it: her copy is there.
  await attempts.getByRole("radio", { name: "Attempt 1" }).click();
  await expect(page).toHaveURL(/attempt=/);
  await expect(bench.getByRole("tabpanel", { name: /^Files/ })).not.toContainText("did not make or touch");
  await bench.getByRole("tab", { name: /^Changes/ }).click();
  await expect(changes.getByRole("button")).toHaveText([/^copy\.md/]);

  // Her lane's summary opens the copy on the same try, which the address keeps.
  const picked = new URL(page.url()).hash.match(/attempt=([^&]+)/)?.[1];
  expect(picked).toBeDefined();
  await (await taskSummary(page, "Draft the copy"))
    .getByRole("button", { name: "See the change to copy.md in Changes" })
    .click();
  await expect(page).toHaveURL(new RegExp(`attempt=${picked}`));
  await expect(changes.getByRole("button", { name: /^copy\.md/ })).toHaveAttribute("aria-pressed", "true");
});

// covers UX-002, UX-006
test("[TC-UX-282] a file two hobs changed opens the hob's own record when Files and Changes link to each other", async ({
  page,
}) => {
  await startParty(page, [
    "Draft the copy",
    'fake:write copy.md "# Copy\\n\\nHello.\\n"',
    'fake:write notes.md "# Notes\\n\\nLaunch day, with copy.\\n"',
    script("complete_task", { key: "drafted", summary: "Drafted." }),
  ]);
  await expect(laneHead(page, "Quill")).toContainText("Done", { timeout: 30_000 });
  const { bench, changes, files } = lists(page);

  // Both hobs changed the notes, and each change is listed with its hob.
  await bench.getByRole("tab", { name: /^Changes/ }).click();
  await expect(changes.getByRole("button")).toHaveText([
    /^notes\.md, by Aldric/,
    /^copy\.md, by Quill/,
    /^notes\.md, by Quill/,
  ]);

  // Files lists each hob's notes too.
  await bench.getByRole("tab", { name: /^Files/ }).click();
  await expect(files.getByRole("button")).toHaveText([
    /^notes\.md, by Aldric/,
    /^copy\.md, by Quill/,
    /^notes\.md, by Quill/,
  ]);

  // Quill's notes in Files open Quill's change to them, not Aldric's.
  await files.getByRole("button", { name: /^notes\.md\s*, by Quill/ }).click();
  await bench
    .getByRole("tabpanel", { name: /^Files/ })
    .getByRole("region", { name: "notes.md" })
    .getByRole("button", { name: "See changes" })
    .click();
  await expect(bench.getByRole("tab", { name: /^Changes/ })).toHaveAttribute("aria-selected", "true");
  await expect(changes.getByRole("button", { name: /^notes\.md\s*, by Quill/ })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  // And Aldric's change opens Aldric's file back in Files.
  await changes.getByRole("button", { name: /^notes\.md\s*, by Aldric/ }).click();
  await bench
    .getByRole("tabpanel", { name: /^Changes/ })
    .getByRole("article", { name: "notes.md" })
    .getByRole("button", { name: "Open in Files" })
    .click();
  await expect(files.getByRole("button", { name: /^notes\.md\s*, by Aldric/ })).toHaveAttribute("aria-pressed", "true");
});

// covers UX-006, CH-005, CH-009
test("[TC-UX-283] a member's History opens an archived Quest's room in its lead's chat, and Close room reads the chat in the Archive", async ({
  page,
}) => {
  const { url, aldric, members, api, folder } = await aldricHub(undefined, ["Quill"]);
  const quill = members[0] ?? "";
  await api("PATCH", `/agents/${quill}/permissions`, { ownFolders: [folder] });
  await page.goto(`${url}/#/hobs/${aldric}/new`);
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  await composer.fill(
    [
      TITLE,
      script("start_quest", { key: "quest", goal: TITLE }),
      script("delegate_task", {
        key: "copy",
        hob: "Quill",
        brief: [
          "Draft the copy",
          'fake:write copy.md "# Copy\\n\\nHello.\\n"',
          script("complete_task", { key: "drafted", summary: "Drafted." }),
        ].join("\n"),
      }),
    ].join("\n"),
  );
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeHidden({ timeout: 30_000 });
  await openRoom(page, TITLE);
  await expect(laneHead(page, "Quill")).toContainText("Done", { timeout: 30_000 });
  const threadId = /threads\/([^?/]+)/.exec(page.url())?.[1] ?? "";
  // Aldric's turn on Quill's result has to end before the hub lets the thread be archived.
  await expect
    .poll(
      () =>
        api("POST", `/threads/${threadId}/archive`, {}).then(
          () => "archived",
          () => "busy",
        ),
      { timeout: 30_000 },
    )
    .toBe("archived");

  // Quill's History opens her Workbench in Aldric's chat, where the work was asked for.
  await page.goto(`${url}/#/hobs/${quill}?tab=history`);
  const history = page.getByRole("tabpanel", { name: "History" });
  const drafted = history.getByRole("listitem").filter({ hasText: "Drafted." });
  await drafted.getByRole("link", { name: "Workbench" }).click();
  await expect(page).toHaveURL(new RegExp(`#/hobs/${aldric}/threads/${threadId}\\?`));

  // The archived Quest's room stays open with its Workbench, and the chat beside it says where to read it.
  await expect(dock(page)).toBeVisible();
  const read = page.getByRole("link", { name: "Read it in the Archive" });
  await expect(read).toBeVisible();
  await expect(page.getByRole("textbox", { name: /^Message Aldric/ })).toHaveCount(0);

  // Closing the room reads the chat in the Archive.
  await page.getByRole("button", { name: "Close room" }).click();
  await expect(page).toHaveURL(new RegExp(`#/archive/chats/${aldric}/${threadId}`));
});
