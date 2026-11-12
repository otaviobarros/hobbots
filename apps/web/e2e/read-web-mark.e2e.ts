import type { Page } from "@playwright/test";
import { expect, test } from "./hub.ts";
import { openWorkbench, ticket } from "./quest-sheet.ts";
import { aldricHub, script, stopAldricHub } from "./workbench-hub.ts";

// Issue #1268: the read-the-web mark shows on an open Workbench as the session reads the web.

test.afterEach(stopAldricHub);

/** Sends a message to Aldric and waits until his turn is underway. */
const send = async (page: Page, lines: ReadonlyArray<string>) => {
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  await composer.fill(lines.join("\n"));
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeVisible();
};

/** Waits for Aldric's turn to end. */
const settled = (page: Page) => expect(page.getByRole("button", { name: "■ Stop" })).toBeHidden({ timeout: 30_000 });

// covers ADR 036 (The read-the-web mark), UX-006
test("[TC-UX-1268-01] a Workbench left open shows Read the web as soon as the running turn searches, before the turn ends", async ({
  page,
}) => {
  const { url, aldric } = await aldricHub();
  await page.goto(`${url}/#/hobs/${aldric}/chat`);
  await send(page, ["Look into lamp oil", script("start_quest", { key: "quest", goal: "Look into lamp oil" })]);
  await expect(ticket(page, "Look into lamp oil")).toBeVisible({ timeout: 20_000 });
  await settled(page);

  // The Workbench is open before the session reads anything, so it shows no mark.
  await openWorkbench(page, ticket(page, "Look into lamp oil"));
  const bench = page.getByRole("region", { name: "Workbench for Look into lamp oil" });
  const header = bench.locator("header").first();
  await expect(header).toBeVisible();
  await expect(header).not.toContainText("Read the web");

  // The next turn searches, then runs a command that keeps it going: the open Workbench shows the
  // mark while the turn still runs, with no reload.
  await send(page, [
    "Search for it",
    "fake:search lamp oil",
    `fake:run ${JSON.stringify({ command: "sleep 600", output: "waiting\n", live: true })}`,
  ]);
  const tag = header.getByText("Read the web", { exact: true });
  await expect(tag).toBeVisible({ timeout: 20_000 });
  await expect(tag).toHaveAttribute("title", /the web search "lamp oil"/);
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeVisible();

  await page.getByRole("button", { name: "■ Stop" }).click();
  await settled(page);
});
