import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "./hub.ts";
import { openWorkbench, ticket } from "./quest-room.ts";
import { aldricHub, script, stopAldricHub } from "./workbench-hub.ts";

test.afterEach(stopAldricHub);

// Wide enough that the Changes and Files lists sit beside the file; under 720px a picker takes their place.
test.use({ viewport: { width: 1600, height: 900 } });

/** A one-pixel PNG. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
/** A two-by-one PNG. */
const WIDE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAADklEQVR4nGP4z8DwH4QBEfcD/ePF9e8AAAAASUVORK5CYII=",
  "base64",
);

/** Leaving the app's window and coming back to it, as the browser tells the page. */
const comeBack = (page: Page) =>
  page.evaluate(() => {
    window.dispatchEvent(new Event("blur"));
    window.dispatchEvent(new Event("focus"));
  });
const PDF = "%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n";

/**
 * Aldric, in one turn, writes a report, makes a data file and edits the notes and an `.env` with a
 * command, and finishes the Task naming the report, a chart and a PDF already in his folder as
 * what he made. Answers the
 * Files tab of the Task's Workbench and Aldric's folder.
 */
const finishedTask = async (page: Page) => {
  const { url, aldric, folder } = await aldricHub({
    "notes.md": "# Notes\n",
    ".env": "API_TOKEN=old\n",
    "chart.png": PNG,
    "brief.pdf": PDF,
  });
  await page.goto(`${url}/#/hobs/${aldric}/new`);
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  await composer.fill(
    [
      "Write the launch report",
      'fake:write report.md "# Launch report\\n\\nEverything shipped.\\n"',
      `fake:run ${JSON.stringify({
        command: "npm run report",
        writes: { "data/sales.csv": "day,sales\nmon,3\n", "notes.md": "# Notes\n\nDone.\n", ".env": "API_TOKEN=new\n" },
        output: "Wrote the sales\n",
      })}`,
      script("start_quest", { key: "quest", goal: "Write the launch report" }),
      script("complete_task", {
        key: "done",
        summary: "The report is written.",
        artifacts: [
          { kind: "file", label: "Launch report", value: join(folder, "report.md") },
          { kind: "file", label: "Sales chart", value: join(folder, "chart.png") },
          { kind: "file", label: "Brief", value: "brief.pdf" },
        ],
      }),
    ].join("\n"),
  );
  await composer.press("Enter");
  const questTicket = ticket(page, "Write the launch report");
  await expect(questTicket).toContainText("Finished in", { timeout: 30_000 });
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeHidden({ timeout: 30_000 });
  await openWorkbench(page, questTicket);
  const bench = page.getByRole("region", { name: "Workbench for Write the launch report" });
  await bench.getByRole("tab", { name: /^Files/ }).click();
  return { files: bench.getByRole("tabpanel", { name: /^Files/ }), folder };
};

// covers UX-002
test("[TC-UX-040] a finished Task's Files tab lists what it made first, previews it, and downloads it in a browser", async ({
  page,
}) => {
  const { files } = await finishedTask(page);
  const list = files.getByRole("navigation", { name: "Files from this task" });
  await expect(list.getByRole("region", { name: "Made in this task" }).getByRole("button")).toHaveText([
    /^BriefMade · brief\.pdf/,
    /^Sales chartMade · chart\.png/,
    /^Launch reportMade · report\.md/,
  ]);
  await expect(list.getByRole("region", { name: "Changed in this task" }).getByRole("button")).toHaveText([
    /^\.envEdited/,
    /^sales\.csvAdded · data\//,
    /^notes\.mdEdited/,
  ]);

  // What it made opens rendered.
  await list.getByRole("button", { name: /^Launch report/ }).click();
  const report = files.getByRole("region", { name: "report.md" });
  await expect(report.getByRole("heading", { name: "Launch report" })).toBeVisible();
  await expect(report).toContainText("Markdown");

  // In a browser it downloads through the hub, as the file itself.
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    report.getByRole("link", { name: "Download report.md" }).click(),
  ]);
  expect(download.suggestedFilename()).toBe("report.md");
  expect(readFileSync(await download.path(), "utf8")).toBe("# Launch report\n\nEverything shipped.\n");
  await expect(report.getByRole("button", { name: /Show .* in Finder/ })).toHaveCount(0);
});

// covers UX-002
test("[TC-UX-041] the Files tab previews images, PDF and text, with each kind and size", async ({ page }) => {
  const { files } = await finishedTask(page);
  const list = files.getByRole("navigation", { name: "Files from this task" });

  await list.getByRole("button", { name: /^Sales chart/ }).click();
  const image = files.getByRole("img", { name: "Preview of chart.png" });
  await expect(image).toBeVisible();
  expect(await image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1);

  await list.getByRole("button", { name: /^Brief/ }).click();
  const pdf = files.locator("iframe[title='Preview of brief.pdf']");
  await expect(pdf).toBeVisible();
  const served = await page.request.get((await pdf.getAttribute("src")) ?? "");
  expect(served.headers()["content-type"]).toBe("application/pdf");

  await list.getByRole("button", { name: /^sales\.csv/ }).click();
  const sales = files.getByRole("region", { name: "sales.csv" });
  // Plain text shows each line with its number.
  await expect(sales.getByRole("document", { name: "Preview of sales.csv" }).getByRole("row")).toHaveText([
    "1day,sales",
    "2mon,3",
  ]);
  await expect(sales).toContainText("Text · 16 byte");
});

// covers UX-002, UX-006
test("[TC-UX-042] a file changed or deleted since the Task says so, one no longer there offers no download, and a preview left open shows each new version", async ({
  page,
}) => {
  const { files, folder } = await finishedTask(page);
  // After the Task, someone edits the notes and deletes the sales.
  writeFileSync(join(folder, "notes.md"), "# Notes\n\nEdited by you.\n");
  rmSync(join(folder, "data", "sales.csv"));
  await page.reload();
  await page.getByRole("tab", { name: /^Files/ }).click();
  const list = files.getByRole("navigation", { name: "Files from this task" });

  await expect(list.getByRole("button", { name: /^notes\.md/ })).toContainText("Changed since this task");
  await list.getByRole("button", { name: /^notes\.md/ }).click();
  await expect(files.getByRole("region", { name: "notes.md" })).toContainText("Edited by you.");

  await expect(list.getByRole("button", { name: /^sales\.csv/ })).toContainText("No longer there");
  await list.getByRole("button", { name: /^sales\.csv/ }).click();
  const sales = files.getByRole("region", { name: "sales.csv" });
  await expect(sales).toContainText("This file is no longer there.");
  await expect(sales.getByRole("link", { name: /Download/ })).toHaveCount(0);

  // An image, edited while it stays open, is loaded again.
  await list.getByRole("button", { name: /^Sales chart/ }).click();
  const image = files.getByRole("img", { name: "Preview of chart.png" });
  await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1);
  writeFileSync(join(folder, "chart.png"), WIDE_PNG);
  await comeBack(page);
  await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(2);

  // A text, edited twice while it stays open, shows each version.
  await list.getByRole("button", { name: /^notes\.md/ }).click();
  const notes = files.getByRole("region", { name: "notes.md" });
  await expect(notes).toContainText("Edited by you.");
  for (const edit of ["First edit.", "Second edit."]) {
    writeFileSync(join(folder, "notes.md"), `# Notes\n\n${edit}\n`);
    await comeBack(page);
    await expect(notes).toContainText(edit);
  }
});

// covers PE-005
test("[TC-UX-043] a file whose name marks it as secret is listed but never shown or downloaded", async ({ page }) => {
  const { files } = await finishedTask(page);
  await files.getByRole("button", { name: /^\.env/ }).click();
  const env = files.getByRole("region", { name: ".env" });
  await expect(env).toContainText("Contents not kept: this file may hold secrets.");
  await expect(env).not.toContainText("API_TOKEN");
  await expect(env.getByRole("link", { name: /Download/ })).toHaveCount(0);
});

// covers UX-002
test("[TC-UX-044] in the desktop app a file shows in Finder instead of downloading, and says when Finder cannot find it", async ({
  page,
}) => {
  // The desktop app's bridge, as its preload script gives it to the page: here it records each call.
  await page.addInitScript(() => {
    const calls: Array<[string, string]> = [];
    Object.assign(window, {
      hobbots: {
        showFile: async (attemptId: string, fileId: string) => {
          calls.push([attemptId, fileId]);
          return calls.length === 1;
        },
      },
      showFileCalls: calls,
    });
  });
  const { files } = await finishedTask(page);
  await files.getByRole("button", { name: /^Launch report/ }).click();
  const report = files.getByRole("region", { name: "report.md" });
  await expect(report.getByRole("link", { name: /Download/ })).toHaveCount(0);
  await report.getByRole("button", { name: "Show report.md in Finder" }).click();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { showFileCalls: unknown[] }).showFileCalls.length))
    .toBe(1);
  const [call] = await page.evaluate(() => (window as unknown as { showFileCalls: string[][] }).showFileCalls);
  expect(call).toHaveLength(2);
  expect(call?.every((id) => /^[\w-]+$/.test(id))).toBe(true);
  await expect(report).not.toContainText("Finder could not find this file");

  // A second time the file is gone from where the hub listed it.
  await report.getByRole("button", { name: "Show report.md in Finder" }).click();
  await expect(report).toContainText("Finder could not find this file. It may have moved since.");
});
