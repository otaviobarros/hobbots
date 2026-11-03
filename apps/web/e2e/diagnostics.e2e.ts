import { expect, test } from "./hub.ts";
import { questHub, stopQuestHub } from "./quest-hub.ts";

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
  await page.getByRole("tab", { name: "Quest" }).click();
  const tasks = page.getByRole("list", { name: "Tasks of Plan the Black Friday campaign" });
  await expect(tasks.getByRole("button", { name: /Ada · Build the campaign/ })).toContainText("you", {
    timeout: 15_000,
  });

  await page.goto(`${url}/#/settings`);
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

  // Titles go in only when you turn them on.
  await diagnostics.getByRole("switch", { name: "Include titles" }).click();
  await diagnostics.getByRole("button", { name: "Make report" }).click();
  await expect(report).toContainText('"title": "A Black Friday campaign');
  await expect(report).toContainText('"title": "Draft the landing copy"');
});
