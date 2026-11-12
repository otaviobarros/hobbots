import { mkdirSync, rmSync } from "node:fs";
import type { Page } from "@playwright/test";
import { expect, test } from "./hub.ts";
import { aldricHub, stopAldricHub } from "./workbench-hub.ts";

// Issue #1241 in the browser: on a hub whose Git config sets no name and email and with no GitHub
// account connected, the hub asks in the chat whether the hob will write code, in plain words, with
// Set up GitHub leading to the hob's Charms tab and no answer box. Not for this hob stops it, and
// Settings › Charms shows that and shows the card again. The hub's rules for asking, for every hob
// and with GitHub connected, are proven in apps/server/test/commit-identity.test.ts.

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

const COMMIT = `fake:run ${JSON.stringify({ command: 'git commit -am "Save the notes"', output: "", exitCode: 0 })}`;

// covers OR-004, IN-004, UX-001
test("[TC-OR-1241-05] with no Git identity the chat asks in plain words whether the hob will write code, leads to its GitHub section, and Not for this hob is shown and undone in Settings", async ({
  page,
  scan,
}) => {
  test.setTimeout(150_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  home = `${test.info().outputDir}-no-git`;
  mkdirSync(home, { recursive: true });
  const { url, aldric } = await aldricHub(undefined, [], { HOBBOTS_GIT_HOME: home });
  await page.goto(`${url}/#/hobs/${aldric}/chat`);

  // Aldric's turn may commit, so the hub asks once, in this chat's tray, with no Git terms and no box.
  await ask(page, ["Save the notes", COMMIT]);
  const tray = page.getByRole("region", { name: /^Needs you/ });
  const asks = tray.getByRole("region", { name: "Your hub asks you" });
  await expect(asks).toContainText("Will Aldric write code?", { timeout: 30_000 });
  await expect(asks).toHaveCount(1);
  await expect(asks).not.toContainText("git config");
  await expect(asks.getByRole("textbox")).toHaveCount(0);
  await scan(tray);

  // Set up GitHub opens Aldric's Charms tab, where his GitHub section is, and the card stays.
  await asks.getByRole("link", { name: "Set up GitHub" }).click();
  await expect(page).toHaveURL(new RegExp(`#/hobs/${aldric}/profile\\?tab=charms`));
  await expect(page.getByRole("tab", { name: /Charms/, selected: true })).toBeVisible();
  await scan(page.getByRole("main"));
  await page.goBack();
  await expect(asks).toContainText("Will Aldric write code?");

  // Not for Aldric: the card leaves, and his next turn that may commit asks nothing.
  await asks.getByRole("button", { name: /Not for Aldric/ }).click();
  await expect(asks).toHaveCount(0);
  await ask(page, ["Save the notes again", COMMIT]);
  await expect(page.getByRole("button", { name: /Stop/ })).toBeHidden({ timeout: 60_000 });
  await expect(asks).toHaveCount(0);

  // Settings › Charms says so, and Show it again clears it.
  await page.goto(`${url}/#/settings/connections?tab=charms`);
  await expect(page.getByText("You turned it off for Aldric.")).toBeVisible({ timeout: 15_000 });
  await scan(page.getByRole("main"));
  await page.getByRole("button", { name: "Show it again" }).click();
  await expect(page.getByText("You turned it off for Aldric.")).toBeHidden();
});
