import type { Page } from "@playwright/test";
import { expect, test } from "./hub.ts";
import { openWorkbench, ticket } from "./quest-room.ts";
import { colored, hobTerminal, rows } from "./terminal.ts";
import { aldricHub, script, stopAldricHub } from "./workbench-hub.ts";

// Issues #389 and #908: the Workbench's Terminal replays what each hob ran in a real terminal,
// xterm.js, read-only, with a tab per hob and a split view, dark in every theme (ADR 023).

test.afterEach(stopAldricHub);

/** A prompt line that makes the fake run a command, with what it prints and how it exits. */
const run = (input: object) => `fake:run ${JSON.stringify(input)}`;

/** Sends a message to Aldric and waits until his turn is underway. */
const send = async (page: Page, lines: ReadonlyArray<string>) => {
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  await composer.fill(lines.join("\n"));
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeVisible();
};

/** Waits for Aldric's turn to end. */
const settled = (page: Page) => expect(page.getByRole("button", { name: "■ Stop" })).toBeHidden({ timeout: 30_000 });

/** Opens the Task's Workbench from its ticket in the chat, on its Terminal. */
const openTerminal = async (page: Page, title: string) => {
  const questTicket = ticket(page, title);
  await openWorkbench(page, questTicket);
  const bench = page.getByRole("region", { name: `Workbench for ${title}` });
  await bench.getByRole("tab", { name: /^Terminal/ }).click();
  return { questTicket, bench, panel: bench.getByRole("tabpanel", { name: /^Terminal/ }) };
};

// covers UX-002, UX-006, PE-005
test("[TC-UX-045] a finished Task's Terminal replays its commands in a read-only terminal: prompt lines, colored output, exit codes, redacted and folded", async ({
  page,
}) => {
  const { url, aldric, folder } = await aldricHub();
  await page.goto(`${url}/#/hobs/${aldric}/new`);
  // In one turn Aldric runs three commands, one failing in color, one printing a token, one printing a lot.
  await send(page, [
    "Check the notes",
    run({ command: "npm run lint", output: "\u001b[31mnotes.md: 2 problems\u001b[0m\n", exitCode: 1 }),
    run({ command: "echo deploy", output: "using ghp_0123456789abcdefghijklmnopqrstuvwxyzAB\n", exitCode: 0 }),
    "fake:tool Bash seq 30000",
    script("start_quest", { key: "quest", goal: "Check the notes" }),
    script("complete_task", { key: "done", summary: "Checked." }),
  ]);
  const questTicket = ticket(page, "Check the notes");
  await expect(questTicket).toContainText("Finished in", { timeout: 30_000 });
  await settled(page);

  const { bench, panel } = await openTerminal(page, "Check the notes");
  await expect(bench.locator("header").first()).toContainText("History");
  await expect(panel).toContainText("3 commands · 1 failed");
  await expect(panel).toContainText("A record of what ran. You cannot type here.");
  const terminal = hobTerminal(panel, "Aldric");
  await expect(panel.getByRole("tab", { name: /^Aldric/ })).toHaveAttribute("aria-selected", "true");
  // It opens on the end, where the last command's output and how it ended are.
  await expect(rows(terminal)).toContainText("30000");
  await expect(rows(terminal)).toContainText(`✓ ran in ${folder}`);

  // The whole log of the long command is one click away, below the terminal.
  const log = panel.getByRole("link", { name: /^seq 30000/ });
  const href = await log.getAttribute("href");
  const whole = await page.evaluate(
    async (address) => (await fetch(address ?? "", { credentials: "include" })).text(),
    href,
  );
  expect(whole.split("\n")).toHaveLength(30_001);

  // Search finds the earlier commands, scrolling the terminal to each: the failed lint, in red,
  // with its exit code in red too and where it ran in the dim line after it.
  const find = panel.getByRole("searchbox", { name: "Find in the terminal" });
  await find.fill("npm run lint");
  await expect(panel.getByRole("status")).toHaveText("1 of 1");
  const screen = rows(terminal);
  await expect(screen).toContainText(`aldric@${folder.split("/").at(-1)} $ npm run lint`);
  await expect(colored(terminal, "red", "notes.md: 2 problems")).toBeVisible();
  await expect(colored(terminal, "red", "✗ exit code 1")).toBeVisible();
  await expect(screen).toContainText(`ran in ${folder} · in the sandbox`);

  // Output is redacted before it is kept.
  await find.fill("deploy");
  await expect(screen).toContainText("[redacted: GitHub token]");
  await expect(screen).not.toContainText("ghp_0123456789");
  // Long output shows its start and end, with how much was left out between them.
  await find.fill("left out here");
  await expect(panel.getByRole("status")).toHaveText("1 of 1");
  await expect(screen).toContainText(/left out here · Open the full log/);
  await find.fill("zzz");
  await expect(panel.getByRole("status")).toHaveText("No matches");

  // Nothing takes typing: the terminal's input is read-only, and Tab leaves it.
  const input = terminal.getByRole("textbox", { name: "Aldric's terminal, read-only" });
  await expect(input).toHaveAttribute("readonly");
  await input.focus();
  await page.keyboard.type("rm -rf /");
  await expect(screen).not.toContainText("rm -rf");
  await page.keyboard.press("Tab");
  await expect(input).not.toBeFocused();
});

// covers UX-002, UX-006
test("[TC-UX-046] while a turn runs the Terminal is Live: a running command counts its time, then reads Cut off when the turn is stopped", async ({
  page,
}) => {
  const { url, aldric } = await aldricHub();
  await page.goto(`${url}/#/hobs/${aldric}/new`);
  // The first turn starts the Quest, so the next turn's commands belong to its Attempt.
  await send(page, ["Watch the build", script("start_quest", { key: "quest", goal: "Watch the build" })]);
  const questTicket = ticket(page, "Watch the build");
  await expect(questTicket).toBeVisible({ timeout: 20_000 });
  await settled(page);

  // The second turn runs a command that keeps running until the turn ends.
  await send(page, ["Keep watching", "fake:tool Bash echo started", "fake:tool Bash sleep 600"]);
  const { bench, panel } = await openTerminal(page, "Watch the build");
  await expect(bench.locator("header").first()).toContainText("●Live");
  await expect(panel).toContainText("2 commands · 1 running", { timeout: 20_000 });
  await expect(panel.getByRole("tab", { name: /^Aldric,? running$/ })).toBeVisible();
  const screen = rows(hobTerminal(panel, "Aldric"));
  await expect(screen).toContainText("$ echo started");
  await expect(screen).toContainText("$ sleep 600");
  // Claude Code reports a command's output only when it ends, so the Terminal counts its time.
  await expect(screen).toContainText(/Running · \d+ sec · Its output shows when it ends\./);
  const first = await screen.textContent();
  await expect.poll(async () => screen.textContent(), { timeout: 5_000 }).not.toBe(first);

  // Stopped, the turn ends with the command still running: whether it finished is not known.
  await page.getByRole("button", { name: "■ Stop" }).click();
  await settled(page);
  await openTerminal(page, "Watch the build");
  await expect(screen).toContainText(
    "? Cut off · The turn ended while this ran, so whether it finished is not known.",
    { timeout: 20_000 },
  );
  await expect(colored(hobTerminal(panel, "Aldric"), "yellow", "Cut off")).toBeVisible();
});

// covers UX-002, UX-006
test("[TC-UX-183] a command whose runtime reports output as it comes shows it live in the terminal while it runs", async ({
  page,
}) => {
  const { url, aldric } = await aldricHub();
  await page.goto(`${url}/#/hobs/${aldric}/new`);
  await send(page, ["Ship the preview", script("start_quest", { key: "quest", goal: "Ship the preview" })]);
  await expect(ticket(page, "Ship the preview")).toBeVisible({
    timeout: 20_000,
  });
  await settled(page);

  // The deploy prints as it goes and keeps running until the turn ends.
  await send(page, [
    "Deploy it",
    run({
      command: "sleep 600 && pnpm deploy --preview",
      output: "Uploading 38 files…\n\u001b[32m✓ 23 of 38\u001b[0m\n",
      live: true,
    }),
  ]);
  const { bench, panel } = await openTerminal(page, "Ship the preview");
  await expect(bench.locator("header").first()).toContainText("●Live");
  const terminal = hobTerminal(panel, "Aldric");
  await expect(rows(terminal)).toContainText("$ sleep 600 && pnpm deploy --preview", { timeout: 20_000 });
  await expect(rows(terminal)).toContainText("Uploading 38 files…");
  await expect(colored(terminal, "green", "✓ 23 of 38")).toBeVisible();
  await expect(rows(terminal)).not.toContainText("Its output shows when it ends.");
  await expect(panel).toContainText("1 command · 1 running");
});

// covers UX-002, OR-002
test("[TC-UX-184] a Quest's Terminal has a tab per hob, the Task's own first, and Split shows them side by side", async ({
  page,
}) => {
  const { url, aldric, members, api, folder } = await aldricHub(undefined, ["Quill"]);
  await api("PATCH", `/agents/${members[0]}/permissions`, { ownFolders: [folder] });
  await page.goto(`${url}/#/hobs/${aldric}/new`);
  // Aldric checks the status and brings in Quill, who builds the copy.
  await send(page, [
    "Write the launch copy",
    run({ command: "git status --short", output: " M notes.md\n", exitCode: 0 }),
    script("start_quest", { key: "quest", goal: "Write the launch copy" }),
    script("delegate_task", {
      key: "copy",
      hob: "Quill",
      brief: [
        "Check the copy",
        run({ command: "pnpm copy:check", output: "\u001b[32mno issues found\u001b[0m\n", exitCode: 0 }),
        script("complete_task", { key: "checked", summary: "No issues." }),
      ].join("\n"),
    }),
  ]);
  await settled(page);

  const { panel } = await openTerminal(page, "Write the launch copy");
  const tabs = panel.getByRole("tablist", { name: "Terminals" });
  await expect(tabs.getByRole("tab")).toHaveText(["Aldric", "Quill"], { timeout: 30_000 });
  await expect(panel).toContainText("2 commands");
  const aldricTerminal = hobTerminal(panel, "Aldric");
  const quillTerminal = hobTerminal(panel, "Quill");
  await expect(rows(aldricTerminal)).toContainText("$ git status --short");
  await expect(quillTerminal).toBeHidden();

  // One at a time: picking Quill's tab shows his terminal instead.
  await tabs.getByRole("tab", { name: "Quill" }).click();
  await expect(rows(quillTerminal)).toContainText("quill@");
  await expect(colored(quillTerminal, "green", "no issues found")).toBeVisible();
  await expect(aldricTerminal).toBeHidden();

  // Split shows both, side by side, each titled.
  const split = panel.getByRole("button", { name: "◫ Split" });
  await split.click();
  await expect(panel.getByRole("button", { name: "▣ One at a time" })).toHaveAttribute("aria-pressed", "true");
  await expect(aldricTerminal).toBeVisible();
  await expect(quillTerminal).toBeVisible();
  await expect(aldricTerminal).toContainText("Aldric · 1 command");
  await expect(quillTerminal).toContainText("Quill · 1 command");
  const [left, right] = [await aldricTerminal.boundingBox(), await quillTerminal.boundingBox()];
  expect(left !== null && right !== null && left.x + left.width <= right.x + 1 && left.y === right.y).toBe(true);
  await expect(rows(aldricTerminal)).toContainText("$ git status --short");
  await expect(rows(quillTerminal)).toContainText("$ pnpm copy:check");

  // Picking a tab while split shows that one alone again.
  await tabs.getByRole("tab", { name: "Aldric" }).click();
  await expect(quillTerminal).toBeHidden();
  await expect(panel.getByRole("button", { name: "◫ Split" })).toHaveAttribute("aria-pressed", "false");
});

// covers UX-002
test("[TC-UX-186] a Quest's Terminal says when another Task's commands could not be read, and Try again brings them", async ({
  page,
}) => {
  const { url, aldric, members, api, folder } = await aldricHub(undefined, ["Quill"]);
  await api("PATCH", `/agents/${members[0]}/permissions`, { ownFolders: [folder] });
  await page.goto(`${url}/#/hobs/${aldric}/new`);
  await send(page, [
    "Write the launch copy",
    run({ command: "git status --short", output: " M notes.md\n", exitCode: 0 }),
    script("start_quest", { key: "quest", goal: "Write the launch copy" }),
    script("delegate_task", {
      key: "copy",
      hob: "Quill",
      brief: [
        "Check the copy",
        run({ command: "pnpm copy:check", output: "no issues found\n", exitCode: 0 }),
        script("complete_task", { key: "checked", summary: "No issues." }),
      ].join("\n"),
    }),
  ]);
  await settled(page);

  // Reading Quill's Task fails while Aldric's own reads as usual.
  const activity = "**/attempts/*/activity";
  await page.route(activity, async (route) => {
    const response = await route.fetch();
    if ((await response.text()).includes("pnpm copy:check")) await route.fulfill({ status: 500, body: "" });
    else await route.fulfill({ response });
  });
  const { panel } = await openTerminal(page, "Write the launch copy");
  await expect(rows(hobTerminal(panel, "Aldric"))).toContainText("$ git status --short", { timeout: 30_000 });
  // The client asks again a few times before it gives up.
  const missing = panel.getByRole("alert");
  await expect(missing).toContainText("The commands of another task in this quest could not be loaded", {
    timeout: 20_000,
  });
  await expect(panel.getByRole("tab", { name: "Quill" })).toHaveCount(0);
  await expect(panel).toContainText("1 command");

  await page.unroute(activity);
  await missing.getByRole("button", { name: "Try again" }).click();
  await expect(missing).toBeHidden();
  await expect(panel.getByRole("tablist", { name: "Terminals" }).getByRole("tab")).toHaveText(["Aldric", "Quill"]);
  await expect(panel).toContainText("2 commands");
});

// covers UX-006
test("[TC-UX-185] the terminal stays dark, with its own palette, in the light themes", async ({ page }) => {
  const { url, aldric } = await aldricHub();
  await page.goto(`${url}/#/hobs/${aldric}/new`);
  await send(page, [
    "List the notes",
    run({ command: "ls", output: "notes.md\n", exitCode: 0 }),
    script("start_quest", { key: "quest", goal: "List the notes" }),
    script("complete_task", { key: "done", summary: "Listed." }),
  ]);
  await settled(page);
  const { bench, panel } = await openTerminal(page, "List the notes");
  const terminal = hobTerminal(panel, "Aldric");
  await expect(rows(terminal)).toContainText("notes.md");
  for (const theme of ["lamplight-paper", "workshop-daylight"]) {
    await page.evaluate((id) => document.documentElement.setAttribute("data-theme", id), theme);
    const colors = await panel.evaluate((element) => {
      const background = (selector: string) => {
        const found = element.querySelector(selector);
        return found === null ? "" : getComputedStyle(found).backgroundColor;
      };
      return {
        page: getComputedStyle(document.body).backgroundColor,
        frame: background('[data-slot="terminal-frame"]'),
        screen: background(".xterm-scrollable-element"),
      };
    });
    expect(colors.page, theme).not.toBe("rgb(12, 12, 17)");
    expect(colors.frame, theme).toBe("rgb(12, 12, 17)");
    expect(colors.screen, theme).toBe("rgb(12, 12, 17)");
  }
  await expect(bench).toBeVisible();
});
