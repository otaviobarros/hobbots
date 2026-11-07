import { mkdirSync, rmSync } from "node:fs";
import type { Page } from "@playwright/test";
import { expect, test } from "./hub.ts";
import { lane, laneHead, openRoom } from "./quest-room.ts";
import { aldricHub, script, stopAldricHub } from "./workbench-hub.ts";

// Issue #741 in the browser: on a hub whose Git config sets no name and email, the hub itself asks
// who hobs commit as, once, in the chat the turn came from, and asks again there when it cannot read
// the answer. Once answered, a Quest member's commit asks nothing more. The fake runtime runs no real
// command, so who that commit is made as is proven with real Git in
// apps/server/test/commit-identity.test.ts, and on Claude Code and Codex in the runtimes' tests.

// A home whose Git config sets no name and email, for the hub to read.
let home = "";
test.afterEach(async () => {
  await stopAldricHub();
  if (home !== "") rmSync(home, { recursive: true, force: true });
});

/** Sends Aldric a message once his last turn has ended. */
const ask = async (page: Page, lines: ReadonlyArray<string>) => {
  await expect(page.getByRole("button", { name: /Stop/ })).toBeHidden({ timeout: 60_000 });
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  await composer.fill(lines.join("\n"));
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled({ timeout: 30_000 });
  await composer.press("Enter");
};

/** A prompt line that makes the fake run a command, with what it prints and how it exits. */
const run = (input: object) => `fake:run ${JSON.stringify(input)}`;

const COMMIT = 'git commit -am "Save the notes"';
const TITLE = "Save the shop notes";

/** Aldric's message that starts a Quest and has Quill commit the notes. */
const questToCommit = [
  TITLE,
  script("start_quest", { key: "quest", goal: TITLE }),
  script("delegate_task", {
    key: "save",
    hob: "Quill",
    brief: [
      TITLE,
      run({ command: COMMIT, output: "[main 1a2b3c4] Save the notes\n", exitCode: 0 }),
      script("complete_task", { key: "saved", summary: "Notes committed." }),
    ].join("\n"),
  }),
  script("wait_for", { key: "wait", tasks: ["$save.task_id"] }),
];

// covers OR-004, IN-004, UX-001
test("[TC-OR-637] with no Git identity the hub asks once in the chat who hobs commit as, asks again there when it cannot read the answer, and a Quest member's later commit asks nothing more", async ({
  page,
  scan,
}) => {
  test.setTimeout(150_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  home = `${test.info().outputDir}-no-git`;
  mkdirSync(home, { recursive: true });
  const { url, aldric, members, api, folder } = await aldricHub(undefined, ["Quill"], { HOBBOTS_GIT_HOME: home });
  await api("PATCH", `/agents/${members[0]}/permissions`, { ownFolders: [folder] });
  await page.goto(`${url}/#/hobs/${aldric}/new`);

  // Aldric's turn may commit, so Hobbots asks you, once and in this chat's tray, who commits.
  await ask(page, ["Save the notes", run({ command: COMMIT, output: "", exitCode: 0 })]);
  const tray = page.getByRole("region", { name: /^Needs you/ });
  const asks = tray.getByRole("region", { name: "Your hub asks you" });
  await expect(asks).toContainText("Your Git config sets no name and email", { timeout: 30_000 });
  await expect(asks).toContainText("Who should hobs commit as?");
  await expect(asks).toHaveCount(1);
  await scan(tray);

  // An answer with no email is asked again, in the same tray; one with a name and email is not.
  const answer = async (words: string) => {
    await asks.getByRole("textbox", { name: "Your answer to your hub" }).fill(words);
    await asks.getByRole("button", { name: "Send answer" }).click();
  };
  await answer("Otavio");
  await expect(asks).toContainText(`Hobbots couldn't find a name and email in "Otavio"`, { timeout: 15_000 });
  await expect(asks).toHaveCount(1);
  await answer("Otavio Barros <otavio@example.com>");
  await expect(asks).toHaveCount(0);

  // Aldric has Quill commit in a Quest, and her turn asks nothing: her lane shows the commit done.
  await ask(page, questToCommit);
  await openRoom(page, TITLE);
  await expect(laneHead(page, "Quill")).toContainText("Done", { timeout: 60_000 });
  const did = lane(page, "Quill").getByRole("list", { name: "What Quill did" });
  await expect(did).toContainText(`Running ${COMMIT}`);
  await expect(did).toContainText("Saved the work in git");
  await expect(page.getByRole("region", { name: "Your hub asks you" })).toHaveCount(0);
});
