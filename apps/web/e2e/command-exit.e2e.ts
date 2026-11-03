import { expect, test } from "./hub.ts";
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
  await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeVisible();
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeHidden({ timeout: 30_000 });

  const card = page.getByRole("region", { name: "Aldric's work on Write the test first" });
  await card.getByRole("button", { name: "Open in Workbench" }).click();
  const bench = page.getByRole("region", { name: "Workbench for Write the test first" });
  await bench.getByRole("tab", { name: /^Terminal/ }).click();
  const panel = bench.getByRole("tabpanel", { name: /^Terminal/ });
  await expect(panel).toContainText("2 commands · 1 failed");

  const commands = panel.getByRole("list", { name: "Commands" }).getByRole("listitem");
  await expect(commands).toHaveCount(2);
  const red = commands.nth(0);
  await expect(red).toContainText("Failed · exit code 1");
  await expect(red).toContainText("ImportError: cannot import name 'notes'");
  // The exit code is shown once, as the command's state, not again as a line of its output.
  await expect(red.getByRole("figure", { name: "Output" })).not.toContainText("Exit code 1");
  const green = commands.nth(1);
  await expect(green).toContainText("Succeeded");
  await expect(green).toContainText("1 passed");
});
