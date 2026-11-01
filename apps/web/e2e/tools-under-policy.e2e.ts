import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
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
    headers: { origin: current.url, ...(body !== undefined && { "content-type": "application/json" }) },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${method} ${path} answered ${response.status}: ${await response.text()}`);
  return (await response.json()) as A;
};

// covers PE-001, PE-002, PE-005
test("[TC-PE-083] under Balanced Pip edits and runs tests without a card, and a read outside its folder is refused", async ({
  page,
}) => {
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
