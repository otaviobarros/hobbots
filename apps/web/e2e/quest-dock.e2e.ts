import type { Page } from "@playwright/test";
import { expect, test } from "./hub.ts";
import { dock, laneHead, laneTask, openRoom } from "./quest-room.ts";
import { aldricHub, script, stopAldricHub } from "./workbench-hub.ts";

// Issue #907 in the browser: one Workbench docked under the lanes for the whole Quest. Changes and
// Files list every hob's work in one list, each row with its hob; a lane filters every tab; and a
// try picked for a lane's Task changes what the tabs show.

test.afterEach(stopAldricHub);

// Wide enough that the Changes and Files lists sit beside the file; under 720px a picker takes their place.
test.use({ viewport: { width: 1600, height: 900 } });

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
  await expect(changes.getByRole("button")).toHaveText([/^notes\.md, by Aldric/, /^copy\.md, by Quill/]);
  await changes.getByRole("button", { name: /^copy\.md/ }).click();
  await expect(
    bench.getByRole("tabpanel", { name: /^Changes/ }).getByRole("article", { name: "copy.md" }),
  ).toContainText("Hello.");

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
  // Quill writes the copy and fails; retried from the same brief, she does nothing and fails again.
  await startParty(page, ["Draft the copy", 'fake:once fake:write copy.md "# Copy\\n\\nHello.\\n"', "fake:fail"]);
  const sheet = laneTask(page, "Draft the copy");
  await expect(sheet).toContainText("Failed", { timeout: 30_000 });
  await sheet
    .getByRole("region", { name: "Controls for Draft the copy" })
    .getByRole("button", { name: "Retry" })
    .click();
  await expect(sheet).toContainText("attempt 2", { timeout: 15_000 });
  await expect(sheet).toContainText("Failed", { timeout: 30_000 });
  const { bench, changes } = lists(page);

  // With no try picked, Quill's work is the first try's, past the retry that did nothing.
  await bench.getByRole("tab", { name: /^Changes/ }).click();
  await expect(changes.getByRole("button")).toHaveText([/^notes\.md, by Aldric/, /^copy\.md, by Quill/]);

  // Lit, her lane's Task names its tries; picking the second changes every tab, and the address keeps it.
  await laneHead(page, "Quill").click();
  const attempts = bench.getByRole("radiogroup", { name: "Attempts" });
  await expect(attempts.getByRole("radio", { name: "Attempt 1" })).toBeChecked();
  await attempts.getByRole("radio", { name: "Attempt 2" }).click();
  await expect(page).toHaveURL(/attempt=/);
  await expect(bench.getByRole("tab", { name: /^Changes/ })).toHaveText("ChangesNot used in this task");
  await expect(bench.getByRole("tabpanel", { name: /^Changes/ })).toContainText(
    "Quill did not change any files in this task.",
  );
  await bench.getByRole("tab", { name: /^Files/ }).click();
  await expect(bench.getByRole("tabpanel", { name: /^Files/ })).toContainText(
    "Quill did not make or touch any files in this task.",
  );

  // Back to the first try, her copy is there again.
  await attempts.getByRole("radio", { name: "Attempt 1" }).click();
  await bench.getByRole("tab", { name: /^Changes/ }).click();
  await expect(changes.getByRole("button")).toHaveText([/^copy\.md/]);
});
