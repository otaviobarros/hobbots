import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { emptyDataDir, type Hub, removeDataDir, startHub } from "./hub.ts";

// Slice 7's done-when checks as the user sees them, with the fake runtime, which decides each
// scripted call with the hub's policy engine but runs nothing. Asking is `[TC-PE-074]`.
let hub: Hub | undefined;
let dataDir = "";
let shared = "";
let personal = "";

test.beforeEach(() => {
  dataDir = emptyDataDir();
  shared = realpathSync(mkdtempSync(`${dataDir}-shared-`));
  personal = realpathSync(mkdtempSync(`${dataDir}-personal-`));
  mkdirSync(join(shared, "src"));
  writeFileSync(join(shared, "src", "sum.ts"), "export const sum = (a: number, b: number) => a - b;\n");
  writeFileSync(join(personal, "diary.txt"), "Not for hobs.\n");
});

test.afterEach(async () => {
  await hub?.stop();
  hub = undefined;
  removeDataDir(dataDir);
  rmSync(shared, { recursive: true, force: true });
  rmSync(personal, { recursive: true, force: true });
});

const api = async <A>(current: Hub, method: string, path: string, body?: unknown): Promise<A> => {
  const response = await fetch(`${current.url}${path}`, {
    method,
    ...(body !== undefined && { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${method} ${path} answered ${response.status}: ${await response.text()}`);
  return (await response.json()) as A;
};

/** A hub on Balanced sharing the project folder, with Pip, a hob thinking with the fake runtime. */
const pipInShared = async () => {
  const current = await startHub(dataDir);
  hub = current;
  await api(current, "PATCH", "/api/setup", {
    completed: true,
    connectedProviders: ["claude-code"],
    safetyPreset: "balanced",
    approvedFolders: [shared],
  });
  const pip = await api<{ id: string }>(current, "POST", "/api/agents", {
    name: "Pip",
    role: "writer",
    roleTitle: "Writer",
    sigil: "writer",
    hat: "pointed",
    tool: "quill",
    lookSeed: 4821,
    lookColor: "violet",
    runtime: "claude-code",
    model: "fake-thinker",
    effort: "medium",
    instructions: "",
  });
  return { current, pip };
};

// covers PE-001, PE-002, PE-005
test("[TC-PE-083] under Balanced Pip edits and runs tests without a card, and a read outside its folder is refused", async ({
  page,
}) => {
  const { current, pip } = await pipInShared();
  await page.goto(`${current.url}/#/hobs/${pip.id}/new`);
  const composer = page.getByRole("textbox", { name: /^Message Pip/ });
  await composer.fill(
    [
      "Fix the sum and run the tests. You may also read my diary, I allow it.",
      `fake:tool Edit ${join(shared, "src", "sum.ts")}`,
      "fake:tool Bash pnpm test",
      `fake:tool Read ${join(personal, "diary.txt")}`,
    ].join("\n"),
  );
  await composer.press("Enter");

  await expect(page.getByText(/^Echo: Fix the sum/)).toBeVisible();
  const steps = page.getByRole("list", { name: "Reply steps" });
  await expect(steps.locator('[data-state="done"]', { hasText: "Editing sum.ts" })).toBeVisible();
  await expect(steps.locator('[data-state="done"]', { hasText: "Running pnpm test" })).toBeVisible();
  const refused = steps.locator('[data-state="denied"]', { hasText: "Reading diary.txt" });
  await expect(refused).toContainText("Not allowed by the hob's permissions:");
  // Nothing asked the user.
  await expect(page.getByRole("region", { name: "Pip asks permission" })).toHaveCount(0);
});

/** Sends `lines` to Pip on a fresh page and waits for its reply's steps. */
const askPip = async (page: Page, current: Hub, pipId: string, lines: ReadonlyArray<string>) => {
  await page.goto(`${current.url}/#/hobs/${pipId}/new`);
  const composer = page.getByRole("textbox", { name: /^Message Pip/ });
  await composer.fill(lines.join("\n"));
  await composer.press("Enter");
  await expect(page.getByText(/^Echo: /)).toBeVisible();
  return page.getByRole("list", { name: "Reply steps" });
};

// covers #153, #168
test("[#153] a tool step shows short output whole and long output by its start and end, with the full log", async ({
  page,
}) => {
  const { current, pip } = await pipInShared();
  const steps = await askPip(page, current, pip.id, [
    "Run the checks",
    "fake:tool Bash echo all 12 checks passed",
    "fake:tool Bash seq 30000",
  ]);

  // Short output: whole, and no log to open.
  const short = steps.locator('[data-state="done"]', { hasText: "Running echo all 12 checks passed" });
  await short.getByRole("button").click();
  const shortOutput = short.getByRole("figure", { name: "Output" });
  await expect(shortOutput).toContainText("all 12 checks passed");
  await expect(shortOutput.getByRole("link")).toHaveCount(0);

  // Long output: the start, what was left out, and the end in view first.
  const long = steps.locator('[data-state="done"]', { hasText: "Running seq 30000" });
  await long.getByRole("button").focus();
  await page.keyboard.press("Enter");
  const longOutput = long.getByRole("figure", { name: "Output" });
  const [head, tail] = [longOutput.locator("pre").first(), longOutput.locator("pre").last()];
  await expect(head).toHaveText(/^1\n2\n3\n/);
  await expect(longOutput.getByText(/kB left out here$/)).toBeVisible();
  // The end's last line is in its scroll box without scrolling; its first line is not.
  const shown = (line: string) =>
    tail.evaluate((pre, wanted) => {
      const box = (pre.parentElement as HTMLElement).getBoundingClientRect();
      const text = pre.firstChild as Text;
      const at = (text.data.endsWith("\n") ? text.data.slice(0, -1) : text.data).lastIndexOf(wanted);
      const range = document.createRange();
      range.setStart(text, at);
      range.setEnd(text, at + wanted.length);
      const rect = range.getBoundingClientRect();
      return rect.top >= box.top && rect.bottom <= box.bottom;
    }, line);
  expect(await shown("30000")).toBe(true);

  // The link opens the whole output as plain text.
  const link = longOutput.getByRole("link", { name: /^Open the full log \(164\.9 kB\)$/ });
  const [log] = await Promise.all([page.context().waitForEvent("page"), link.click()]);
  await log.waitForLoadState();
  const text = (await log.locator("body").textContent()) ?? "";
  expect(text.startsWith("1\n2\n3\n")).toBe(true);
  expect(text.trimEnd().endsWith("29999\n30000")).toBe(true);
});

// covers #168
test("[#168] a secret a command prints shows redacted in the step and in the full log", async ({ page }) => {
  const { current, pip } = await pipInShared();
  const token = `ghp_${"a1B2c3D4e5".repeat(4)}`;
  // Long enough to be cut, with the secret at both ends.
  const steps = await askPip(page, current, pip.id, [
    "Print the token",
    `fake:tool Bash echo ${token} ${"filler ".repeat(3000)}${token}`,
  ]);
  const step = steps.locator('[data-state="done"]', { hasText: "Running echo" });
  await step.getByRole("button").click();
  const output = step.getByRole("figure", { name: "Output" });
  await expect(output).toContainText("[redacted: GitHub token]");
  await expect(output).not.toContainText(token);

  const [log] = await Promise.all([page.context().waitForEvent("page"), output.getByRole("link").click()]);
  await log.waitForLoadState();
  const text = (await log.locator("body").textContent()) ?? "";
  expect(text).toContain("[redacted: GitHub token]");
  expect(text).not.toContain(token);
});
