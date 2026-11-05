import { expect, test } from "./hub.ts";
import { openWorkbench, ticket } from "./quest-room.ts";
import { colored, hobTerminal, rows } from "./terminal.ts";
import { aldricHub, script, stopAldricHub } from "./workbench-hub.ts";

// Issue #591: a command that exits non-zero is Failed with its exit code. The fake runtime reports
// commands through the same hook payloads as Claude Code, so this holds for the real runtime too.

test.afterEach(stopAldricHub);

/** A prompt line that makes the fake run a command, with what it prints and how it exits. */
const run = (input: object) => `fake:run ${JSON.stringify(input)}`;

// covers UX-002, UX-006
test("[TC-RT-105] a command that exits non-zero shows as Failed with its exit code, and one that exits 0 as Succeeded", async ({
  page,
}) => {
  const { url, aldric } = await aldricHub();
  await page.goto(`${url}/#/hobs/${aldric}/new`);
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  // The red step of test-first: the test run fails first, then passes.
  await composer.fill(
    [
      "Write the test first",
      run({ command: "pytest", output: "ImportError: cannot import name 'notes'\n", exitCode: 1 }),
      run({ command: "pytest", output: "1 passed\n", exitCode: 0 }),
      script("start_quest", { key: "quest", goal: "Write the test first" }),
      script("complete_task", { key: "done", summary: "Red, then green." }),
    ].join("\n"),
  );
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeVisible();
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeHidden({ timeout: 30_000 });

  const questTicket = ticket(page, "Write the test first");
  await openWorkbench(page, questTicket);
  const bench = page.getByRole("region", { name: "Workbench for Write the test first" });
  await bench.getByRole("tab", { name: /^Terminal/ }).click();
  const panel = bench.getByRole("tabpanel", { name: /^Terminal/ });
  await expect(panel).toContainText("2 commands · 1 failed");

  const screen = rows(hobTerminal(panel, "Aldric"));
  // The failed run ends with its exit code in red, once: not again as a line of its output.
  await expect(screen).toContainText("ImportError: cannot import name 'notes'");
  await expect(colored(hobTerminal(panel, "Aldric"), "red", "✗ exit code 1")).toBeVisible();
  await expect(screen).not.toContainText("Exit code 1");
  // The passing run ends with a check mark and no exit code.
  await expect(screen).toContainText(/1 passed\s*✓ ran in/);
  expect((await screen.textContent())?.match(/exit code/g)).toHaveLength(1);
});

// Issue #702: `git rev-parse …; git init …` exits with its last command's code, so a line of
// commands run one after another that exits 0 is Finished, never Succeeded: an earlier one may have failed.
// covers UX-002, UX-006
test("[TC-RT-500] a line of commands run one after another that exits 0 shows as Finished, saying an earlier part may have failed", async ({
  page,
}) => {
  const { url, aldric } = await aldricHub();
  await page.goto(`${url}/#/hobs/${aldric}/new`);
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  await composer.fill(
    [
      "Set up the repository",
      run({
        command: "ls notes; echo checked",
        output: "ls: notes: No such file or directory\nchecked\n",
        exitCode: 0,
      }),
      run({ command: "ls && echo listed", output: "README.md\nlisted\n", exitCode: 0 }),
      script("start_quest", { key: "quest", goal: "Set up the repository" }),
      script("complete_task", { key: "done", summary: "Initialized." }),
    ].join("\n"),
  );
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeVisible();
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeHidden({ timeout: 30_000 });

  const questTicket = ticket(page, "Set up the repository");
  await openWorkbench(page, questTicket);
  const bench = page.getByRole("region", { name: "Workbench for Set up the repository" });
  await bench.getByRole("tab", { name: /^Terminal/ }).click();
  const terminal = hobTerminal(bench.getByRole("tabpanel", { name: /^Terminal/ }), "Aldric");
  await expect(rows(terminal)).toContainText("$ ls notes; echo checked");
  await expect(colored(terminal, "yellow", "Finished · an earlier part may have failed")).toBeVisible();
  // A chain that runs on only after a success still ends with a check mark.
  await expect(rows(terminal)).toContainText(/listed\s*✓ ran in/);
  expect((await rows(terminal).textContent())?.match(/Finished · an earlier part/g)).toHaveLength(1);
});
