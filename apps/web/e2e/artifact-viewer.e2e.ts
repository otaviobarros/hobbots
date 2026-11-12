import { rmSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expectAccessible } from "./accessibility.ts";
import { campAt, expect, test } from "./hub.ts";
import { aldricHub, script, stopAldricHub } from "./workbench-hub.ts";

// Issue #1434 (ADR 037, Records): the camp sheet's Artifacts tab previews each artifact and draws it
// by its kind, with its versions, in the sheet and the full viewer, on the fake runtime. A file a
// quest returned by a relative path and also wrote is one row, and only the kinds the camp has show
// as filters.

test.afterEach(stopAldricHub);

/** A PNG of one pixel, as small as an image gets. */
const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z/C/HgAGgwJ/lK3Q6wAAAABJRU5ErkJggg==",
  "base64",
);

/** A fake command that really changes Aldric's folder. */
const run = (command: string, writes: Record<string, string>) =>
  `fake:run ${JSON.stringify({ command, writes, output: "done\n", exitCode: 0 })}`;

/** Sends a scripted turn and waits until it has ended. */
const playTurn = async (page: Page, lines: ReadonlyArray<string>) => {
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  await composer.fill(lines.join("\n"));
  await expect(page.getByRole("button", { name: /^Send( after this reply)?$/ })).toBeEnabled();
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeVisible();
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeHidden({ timeout: 30_000 });
};

// covers CH-001, UX-002, ADR 037 (Records: Artifact)
test("[TC-CH-1434-07] previews each artifact once, and opens a document, code and an image drawn by kind with their versions", async ({
  page,
}) => {
  const { aldric, hub, folder } = await aldricHub({ "hero.png": PIXEL });
  const camp = await campAt(hub, aldric, "Launch");
  await page.goto(camp.url);
  // A quest writes the plan and the code, and returns the plan and the image by their relative paths.
  await playTurn(page, [
    "Draft the launch",
    run("npm run draft", {
      "plan.md": "# Launch plan\n\nShip on Friday.\n",
      "src/app.ts": 'export const greet = () => "hi";\n',
    }),
    script("start_quest", { key: "draft", goal: "Draft the launch" }),
    script("complete_task", {
      delivered: true,
      key: "drafted",
      summary: "Drafted.",
      artifacts: [
        { kind: "file", label: "Launch plan", value: "plan.md" },
        { kind: "file", label: "Hero", value: "hero.png" },
      ],
    }),
  ]);
  // A second quest changes both.
  await playTurn(page, [
    "Revise the launch",
    run("npm run revise", {
      "plan.md": "# Launch plan\n\nShip on Wednesday.\n",
      "src/app.ts": 'export const greet = () => "hello";\n',
    }),
    script("start_quest", { key: "revise", goal: "Revise the launch" }),
    script("complete_task", { delivered: true, key: "revised", summary: "Revised." }),
  ]);

  const main = page.getByRole("main", { name: "Chat" });
  await main.getByRole("button", { name: "Open the sheet for Launch" }).click();
  const sheet = page.getByRole("dialog", { name: "Launch" });
  await sheet.getByRole("tab", { name: /^Artifacts/ }).click();

  // One row each, the plan at its second version; only the kinds the camp has are filters.
  await expect(sheet.getByRole("button", { name: /^Open / })).toHaveCount(3);
  await expect(sheet.getByRole("button", { name: "Open Launch plan" })).toHaveCount(1);
  const filters = sheet.getByRole("radiogroup", { name: "Show artifacts" });
  await expect(filters.getByRole("radio")).toHaveText(["All3", "Code1", "Docs1", "Images1"]);
  const planRow = sheet.getByRole("listitem").filter({ hasText: "Launch plan" });
  await expect(planRow).toContainText("Doc · version 2");
  await expect(planRow).toContainText("Ship on Wednesday.");
  await expectAccessible(page, sheet);

  // The plan, rendered, with its first version one pick away.
  await sheet.getByRole("button", { name: "Open Launch plan" }).click();
  const plan = sheet.getByRole("article", { name: "A preview of Launch plan" });
  await expect(plan.getByRole("heading", { name: "Launch plan" })).toBeVisible();
  await expect(plan).toContainText("Ship on Wednesday.");
  const versions = sheet.getByRole("radiogroup", { name: "Versions" });
  await expect(versions.getByRole("radio")).toHaveText(["v2", "v1"]);
  await versions.getByRole("radio", { name: /^v1/ }).click();
  await expect(plan).toContainText("Ship on Friday.");
  await expect(sheet).toContainText("Version 1 of 2");
  await expectAccessible(page, sheet);

  // The same plan in the full viewer, then back to the list.
  await sheet.getByRole("button", { name: "Full view of Launch plan" }).click();
  const full = page.getByRole("dialog", { name: "Launch plan" });
  await expect(full.getByRole("article", { name: "A preview of Launch plan" })).toContainText("Ship on Friday.");
  await expectAccessible(page, full);
  await full.getByRole("button", { name: "Close the full view" }).click();
  await expect(full).toBeHidden();
  await sheet.getByRole("button", { name: "Back to artifacts" }).click();

  // The code, as a diff against its first version.
  await sheet.getByRole("button", { name: "Open app.ts" }).click();
  const diff = sheet.getByRole("region", { name: "Changes to app.ts" });
  await expect(sheet).toContainText("Changes since version 1");
  await expect(diff).toContainText('export const greet = () => "hello";');
  await expect(diff).toContainText('export const greet = () => "hi";');
  await sheet.getByRole("button", { name: "Back to artifacts" }).click();

  // The image, as it is in Aldric's folder now.
  await filters.getByRole("radio", { name: /^Images/ }).click();
  await sheet.getByRole("button", { name: "Open Hero" }).click();
  const image = sheet.getByRole("img", { name: "Hero, version 1" });
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate((each: HTMLImageElement) => each.naturalWidth)).toBe(1);
  await expectAccessible(page, sheet);

  /** Opens Hero again from a page that has read nothing yet. */
  const openHeroAfresh = async () => {
    await page.reload();
    await main.getByRole("button", { name: "Open the sheet for Launch" }).click();
    await sheet.getByRole("tab", { name: /^Artifacts/ }).click();
    await sheet.getByRole("button", { name: "Open Hero" }).click();
  };

  // A read of the image that does not reach the hub says so, with Read again, not a broken image.
  const heroContents = /\/artifacts\/[^/]+\/versions\/1$/;
  await page.route(heroContents, (route) => route.abort());
  await openHeroAfresh();
  await expect(sheet).toContainText("Couldn't read this version.", { timeout: 15_000 });
  await expect(image).toBeHidden();
  await page.unroute(heroContents);
  await sheet.getByRole("button", { name: "Read again" }).click();
  await expect.poll(() => image.evaluate((each: HTMLImageElement) => each.naturalWidth)).toBe(1);

  // An image the hub no longer serves says why.
  rmSync(join(folder, "hero.png"));
  await openHeroAfresh();
  await expect(sheet).toContainText("The file isn't there any more.");
  await expect(image).toBeHidden();
  await expectAccessible(page, sheet);
});
