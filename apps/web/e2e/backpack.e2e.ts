import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { emptyDataDir, type Hub, removeDataDir, startHub } from "./hub.ts";

// Issue #297 in the browser: what a hob is waiting on, in the hob panel and the Quest tab. The read
// reads themselves are tested in packages/persistence/test/backpack.test.ts.

let hub: Hub | undefined;
let dataDir = "";
let shared = "";

test.beforeEach(() => {
  dataDir = emptyDataDir();
  shared = realpathSync(mkdtempSync(`${dataDir}-shared-`));
});

test.afterEach(async () => {
  await hub?.stop();
  hub = undefined;
  removeDataDir(dataDir);
  rmSync(shared, { recursive: true, force: true });
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

const hobNamed = (current: Hub, name: string, lookSeed: number) =>
  api<{ readonly id: string }>(current, "POST", "/api/agents", {
    name,
    role: "writer",
    roleTitle: "Writer",
    sigil: "writer",
    hat: "pointed",
    tool: "quill",
    lookSeed,
    lookColor: "violet",
    runtime: "claude-code",
    model: "fake-thinker",
    effort: "medium",
    instructions: "",
  });

/** A prompt line that makes the fake call a Task tool. */
const script = (tool: string, input: object) => `fake:hub ${tool} ${JSON.stringify(input)}`;

// covers IN-001, IN-002, IN-004, OR-003
test("[TC-IN-150] Aldric's panel and the Quest tab show Quill's result as awaiting him until his continuation handles it", async ({
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
  const aldric = await hobNamed(current, "Aldric", 4000);
  await hobNamed(current, "Quill", 4821);

  // Aldric brings in Quill, whose push waits for you; Quill finishes once you allow it.
  await page.goto(`${current.url}/#/hobs/${aldric.id}/new`);
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  await composer.fill(
    [
      "Plan the launch",
      script("delegate_task", {
        key: "copy",
        hob: "Quill",
        brief: [
          "Draft the landing copy",
          "fake:tool Bash git push origin feature",
          script("complete_task", { key: "copy-done", summary: "Three headlines." }),
        ].join("\n"),
      }),
    ].join("\n"),
  );
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: /Stop/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Stop/ })).toBeHidden();
  await expect(page).toHaveURL(new RegExp(`/hobs/${aldric.id}/threads/`));
  const thread = page.url();
  await expect(page.getByRole("link", { name: "Inbox, 1 waiting on you" })).toBeVisible({ timeout: 20_000 });

  // Aldric rests, so Quill's result waits in his backpack instead of starting his continuation.
  await api(current, "POST", `/api/agents/${aldric.id}/pause`);
  await page.getByRole("link", { name: "Inbox, 1 waiting on you" }).click();
  await page
    .getByRole("list", { name: "Requests" })
    .getByRole("link", { name: /Push your work/ })
    .click();
  const request = page.getByRole("article", { name: "Request from Quill: Push your work" });
  await request.getByRole("button", { name: "Allow once" }).click();
  await expect(request.getByRole("status")).toHaveText("✓ Allowed once. Quill carries on.");
  await page.goto(thread);

  // Aldric's panel: the result awaits him, from Quill, still waiting for a turn.
  const panel = page.getByRole("region", { name: "What Aldric is waiting on" });
  await expect(panel).toContainText("1 in the backpack", { timeout: 20_000 });
  const result = panel.getByRole("button", { name: /^Quill's result for "Draft the landing copy"/ });
  await expect(result).toContainText("Waiting");
  await expect(page.getByRole("region", { name: "What Quill is waiting on" })).toHaveCount(0);

  // The Quest tab says the same, naming who owes the response.
  const room = page.getByRole("region", { name: "What hobs on Plan the launch are waiting on" });
  await expect(room).toContainText("awaiting Aldric");
  await expect(room).toContainText("Waiting");

  // Opening it opens Quill's Task in the drawer.
  await result.click();
  await expect(page.getByRole("heading", { name: "Draft the landing copy" })).toBeVisible();
  await page.keyboard.press("Escape");

  // Aldric wakes: his continuation reads the result, which shows as consumed and leaves his count.
  await api(current, "POST", `/api/agents/${aldric.id}/wake`);
  await expect(page.getByText("Hobbots wrote this, not the user.").last()).toBeVisible({ timeout: 20_000 });
  await expect(result).toContainText("Consumed", { timeout: 20_000 });
  await expect(panel).not.toContainText("in the backpack");
  await expect(room).toContainText("Consumed");

  // Every hob's view, at the end of the Quest tab, has nothing left waiting.
  await expect(page.getByText("Every hob · 0 waiting")).toBeVisible();
});
