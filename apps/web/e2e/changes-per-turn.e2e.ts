import type { Page } from "@playwright/test";
import { expect, test } from "./hub.ts";
import { aldricHub, script, stopAldricHub } from "./workbench-hub.ts";

// Issue #595: two steps of one Quest working in the same folder at the same time each list only
// their own changes, with paths relative to the same folder.

test.afterEach(stopAldricHub);

// Wide enough that the Changes list sits beside the file; under 720px a picker takes its place.
test.use({ viewport: { width: 1600, height: 900 } });

/** A reply the fake writes back word by word, keeping its step's turn running a few seconds after its work. */
const REPLY = Array.from({ length: 100 }, (_, i) => `word${i + 1}`).join(" ");

/** Opens a step's Workbench from the Quest tab, on its Changes. */
const changesOf = async (page: Page, title: string) => {
  const room = page.getByRole("region", { name: "Control room for Write the docs" });
  await room.getByRole("button", { name: new RegExp(`^Aldric · ${title}`) }).click();
  const controls = room.getByRole("region", { name: `Controls for ${title}` });
  await controls.getByRole("button", { name: "Open in Workbench" }).click();
  const bench = page.getByRole("region", { name: `Workbench for ${title}` });
  await bench.getByRole("tab", { name: /^Changes/ }).click();
  return { bench, panel: bench.getByRole("tabpanel", { name: /^Changes/ }) };
};

// covers UX-002, UX-006
test("[TC-RT-109] two steps working in one folder at once each list only their own changes in the Workbench", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const { url, aldric } = await aldricHub({ "README.md": "# Site\n", "notes.txt": "Notes\n" });
  await page.goto(`${url}/#/hobs/${aldric}/new`);
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  // One step moves the notes with a command; the other writes a review with its Write tool. Each
  // keeps replying for a while after, so their turns overlap.
  const steps = [
    {
      brief: [
        "Move the notes",
        `fake:run ${JSON.stringify({ command: "git mv notes.txt docs/NOTES.md", writes: { "notes.txt": null, "docs/NOTES.md": "Notes\n" } })}`,
        REPLY,
      ].join("\n"),
    },
    { brief: ["Write the review", 'fake:write docs/REVIEW.md "# Review\\n"', REPLY].join("\n") },
  ];
  await composer.fill(["Write the docs", script("plan_steps", { key: "plan", steps })].join("\n"));
  await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeVisible();

  await page.getByRole("tab", { name: "Quest" }).click();
  const room = page.getByRole("region", { name: "Control room for Write the docs" });
  for (const title of ["Move the notes", "Write the review"]) {
    await expect(room.getByRole("button", { name: new RegExp(`^Aldric · ${title}`) })).toContainText("Done", {
      timeout: 45_000,
    });
  }

  const move = await changesOf(page, "Move the notes");
  await expect(move.panel.getByRole("button", { name: /^NOTES\.md docs\/ Moved/ })).toBeVisible();
  await expect(move.panel).not.toContainText("REVIEW.md");
  await move.bench.getByRole("button", { name: "← Back to chat" }).click();
  await page.getByRole("tab", { name: "Quest" }).click();

  const review = await changesOf(page, "Write the review");
  await expect(review.panel.getByRole("button", { name: /^REVIEW\.md docs\/ Added/ })).toBeVisible();
  await expect(review.panel).not.toContainText("NOTES.md");
});
