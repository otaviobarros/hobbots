import type { Page } from "@playwright/test";
import { expect, test } from "./hub.ts";
import { openWorkbench, ticket } from "./quest-sheet.ts";
import { hobTerminal, rows } from "./terminal.ts";
import { aldricHub, script, stopAldricHub } from "./workbench-hub.ts";

// Issue #1056: once a hob has answered and its reply only waits on a command it started, the
// composer, the reply's step and the chat header say what it waits on and for how long. Stop
// waiting ends the reply with its text, and the command shows as stopped by you.

test.afterEach(stopAldricHub);

/** A prompt line that makes the fake run a command, with what it prints and how it exits. */
const run = (input: object) => `fake:run ${JSON.stringify(input)}`;

// The composer with what waits above it.
const composerArea = (page: Page) => page.locator("[data-composer]").locator("..");

const composer = (page: Page) => page.getByRole("textbox", { name: /^Message Aldric/ });

const send = async (page: Page, lines: ReadonlyArray<string>) => {
  await composer(page).fill(lines.join("\n"));
  await composer(page).press("Enter");
};

// covers CH-004, CH-007, CH-008
test("[TC-CH-1056-03] a reply waiting on a command says which one and for how long, and Stop waiting ends it with the command stopped", async ({
  page,
  scan,
}) => {
  const { url, aldric } = await aldricHub();
  await page.goto(`${url}/#/hobs/${aldric}/chat`);
  // A Quest gives the commands a Workbench, whose Terminal shows how each one ended.
  await send(page, ["Start the dev server", script("start_quest", { key: "quest", goal: "Start the dev server" })]);
  await expect(ticket(page, "Start the dev server")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeHidden({ timeout: 30_000 });

  // The dev server never ends on its own, so once Aldric has answered the reply waits on it.
  await send(page, ["Run it", run({ command: "pnpm dev", background: true, outlives: true })]);
  const stopWaiting = page.getByRole("button", { name: "■ Stop waiting" });
  await expect(stopWaiting).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("button", { name: "■ Stop", exact: true })).toBeHidden();
  await expect(page.getByText("Aldric is waiting on pnpm dev · under a minute")).toBeVisible();
  await expect(page.getByText(/Your chat with Aldric · waiting on pnpm dev · under a minute/)).toBeVisible();
  const steps = page.getByRole("list", { name: "Reply steps" }).last();
  await expect(steps).toContainText("Waiting on pnpm dev");
  await expect(steps).toContainText(
    "Running for under a minute. The reply ends when it does, or when you stop waiting.",
  );
  await expect(stopWaiting).toHaveAccessibleDescription(
    "Stop waiting ends this reply now. What Aldric wrote is kept, and pnpm dev is stopped. Messages you send now wait their turn.",
  );

  // A message sent now waits its turn and says what for.
  await send(page, ["Then check the build"]);
  const queued = page.getByRole("region", { name: "Queued message" });
  await expect(queued).toContainText("Waits its turn");
  await expect(queued).toContainText("Goes when pnpm dev ends, or when you stop waiting.");
  await scan(composerArea(page));
  await scan(steps);

  // A Stop waiting the hub never gets says so, and the button is there to try again.
  await page.route("**/stop-waiting", (route) => route.fulfill({ status: 503, body: "" }), { times: 1 });
  await stopWaiting.click();
  const failed = page.getByRole("alert").filter({ hasText: "Hobbots could not stop waiting" });
  await expect(failed).toHaveText(
    "Hobbots could not stop waiting, so pnpm dev still runs and Aldric's reply still waits on it. Press Stop waiting to try again.",
  );
  await expect(stopWaiting).toBeEnabled();
  await expect(steps).toContainText("Waiting on pnpm dev");
  await scan(composerArea(page));

  // Stop waiting ends the reply as done: its text stays and the command shows as stopped by you.
  await stopWaiting.click();
  await expect(stopWaiting).toBeHidden({ timeout: 20_000 });
  const stoppedStep = page.getByRole("list", { name: "Reply steps" }).filter({ hasText: "Running pnpm dev" });
  await expect(stoppedStep).toContainText("Stopped by you after under a minute, while the reply waited on it.");
  await expect(page.getByText(/You stopped this reply/)).toBeHidden();
  await expect(failed).toBeHidden();
  await scan(stoppedStep);

  // The Terminal says the same.
  await openWorkbench(page, ticket(page, "Start the dev server"));
  const bench = page.getByRole("region", { name: "Workbench for Start the dev server" });
  await bench.getByRole("tab", { name: /^Terminal/ }).click();
  const panel = bench.getByRole("tabpanel", { name: /^Terminal/ });
  const screen = rows(hobTerminal(panel, "Aldric"));
  await expect(screen).toContainText("$ pnpm dev", { timeout: 20_000 });
  await expect(screen).toContainText("■ Stopped by you · You stopped it while the reply waited on it.");
  await scan(bench);
});
