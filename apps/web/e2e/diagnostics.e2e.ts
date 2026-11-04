import { expect, test } from "./hub.ts";
import { questHub, stopQuestHub } from "./quest-hub.ts";
import { openQuest } from "./work-sheet.ts";

test.afterEach(stopQuestHub);

// covers OP-002, OR-002, OR-007
test("[TC-OP-053] follows a Quest that delegated to two hobs from Settings › Diagnostics and copies a report without its text", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const { url, aldric } = await questHub();
  await page.goto(`${url}/#/hobs/${aldric}/new`);
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  const request = "Plan a Black Friday campaign for the shop";
  await composer.fill(request);
  await composer.press("Enter");
  // Aldric delegates to Quill and Ada, and Ada asks you a question that waits.
  const tasks = await openQuest(page, "Plan the Black Friday campaign");
  await expect(tasks.getByRole("button", { name: /Ada · Build the campaign/ })).toContainText("you", {
    timeout: 15_000,
  });

  await page.goto(`${url}/#/settings/help`);
  const diagnostics = page.getByRole("region", { name: "Diagnostics" });
  await expect(diagnostics.getByRole("list", { name: "AI providers" })).toContainText("Claude Code");
  await expect(diagnostics.getByRole("list", { name: "Stalled work" })).toContainText("No work is stuck.");

  // The Quest's tree across Aldric, Quill and Ada, with who gave each Task to whom and each try.
  const picker = diagnostics.getByLabel("Quest to follow");
  const option = picker.locator("option", { hasText: "A Black Friday campaign" });
  await expect(option).toContainText("· Aldric ·");
  await picker.selectOption((await option.getAttribute("value")) ?? "");
  const tree = diagnostics.getByRole("list", { name: /^Tasks of A Black Friday campaign/ });
  await expect(tree).toContainText("Aldric · Plan the Black Friday campaign");
  await expect(tree).toContainText("Quill · Draft the landing copy");
  await expect(tree).toContainText("Ada · Build the campaign");
  await expect(tree).toContainText("Given by Aldric to Quill");
  await expect(tree).toContainText("Given by Aldric to Ada");
  await expect(tree).toContainText(/Try 1 · \w+ · Claude Code/);
  await expect(diagnostics.getByRole("list", { name: "Recent events" })).toContainText("Quest started");

  // The report is shown in full first; it holds IDs and states but nothing anyone wrote.
  await diagnostics.getByRole("button", { name: "Make report" }).click();
  const report = diagnostics.getByRole("region", { name: "Diagnostics report" });
  await expect(report).toContainText('"format": "hobbots.diagnostics"');
  await expect(report).toContainText('"memberId"');
  const shown = (await report.textContent()) ?? "";
  for (const text of [request, "Black Friday", "landing copy", "Aldric", "Quill"]) expect(shown).not.toContain(text);
  expect(JSON.parse(shown).quest.tasks.length).toBeGreaterThanOrEqual(3);

  await diagnostics.getByRole("button", { name: "Copy report" }).click();
  await expect(diagnostics.getByRole("button", { name: "Report copied" })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`${shown}`);

  // A report belongs to the Quest it was made for: choosing another drops it, so it cannot be copied by mistake.
  const questValue = (await option.getAttribute("value")) ?? "";
  await picker.selectOption("");
  await expect(report).toHaveCount(0);
  await expect(diagnostics.getByRole("button", { name: /^Copy report|^Report copied/ })).toHaveCount(0);
  await picker.selectOption(questValue);
  await expect(report).toHaveCount(0);
  await diagnostics.getByRole("button", { name: "Make report" }).click();
  await expect(report).toContainText('"format": "hobbots.diagnostics"');

  // Titles go in only when you turn them on, and changing that drops the report made without them.
  await diagnostics.getByRole("switch", { name: "Include titles" }).click();
  await expect(report).toHaveCount(0);
  await diagnostics.getByRole("button", { name: "Make report" }).click();
  await expect(report).toContainText('"title": "A Black Friday campaign');
  await expect(report).toContainText('"title": "Draft the landing copy"');

  // Turning titles off again drops the report that holds them.
  const titles = diagnostics.getByRole("switch", { name: "Include titles" });
  await titles.click();
  await expect(report).toHaveCount(0);

  // A request dropped by a change never lands, even when a newer one asks for the same report:
  // the first answers late with a failure while the second is still on its way, and the second wins.
  let asked = 0;
  let answerFirst = () => {};
  let answerSecond = () => {};
  const firstHeld = new Promise<void>((resolve) => {
    answerFirst = resolve;
  });
  const secondHeld = new Promise<void>((resolve) => {
    answerSecond = resolve;
  });
  await page.route("**/api/diagnostics/report**", async (route) => {
    asked += 1;
    if (asked === 1) {
      await firstHeld;
      await route.fulfill({ status: 500, contentType: "application/json", body: "{}" });
    } else {
      await secondHeld;
      await route.continue();
    }
  });
  const make = diagnostics.getByRole("button", { name: "Make report" });
  await make.click();
  await expect(diagnostics.getByRole("button", { name: "Making…" })).toBeDisabled();
  await titles.click();
  await titles.click();
  await make.click();
  await expect.poll(() => asked).toBe(2);
  const lateFailure = page.waitForResponse(
    (response) => response.url().includes("/diagnostics/report") && response.status() === 500,
  );
  answerFirst();
  await lateFailure;
  await expect(diagnostics.getByRole("alert")).toHaveCount(0);
  await expect(diagnostics.getByRole("button", { name: "Making…" })).toBeDisabled();
  answerSecond();
  await expect(report).toContainText('"format": "hobbots.diagnostics"');
  await expect(report).not.toContainText('"title"');
  await expect(diagnostics.getByRole("alert")).toHaveCount(0);
  await page.unroute("**/api/diagnostics/report**");
});
