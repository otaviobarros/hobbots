import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { emptyDataDir, type Hub, removeDataDir, startHub } from "./hub.ts";

// Issue #273 in the browser: a party member's request reaches you in the Inbox, under its lead's
// thread, and never its lead. The hub-level side is apps/server/test/quests.test.ts.

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
    // As another window of the app, on the hub's own origin: approvals answer only the user (PE-006).
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

// covers PE-006, OR-002
test("[TC-IN-062] a party member's request waits in the Inbox under its lead's thread, opens that chat, and Allow once lets the member go on", async ({
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

  // Aldric brings in Quill, whose Task pushes, which Balanced asks you about.
  await page.goto(`${current.url}/#/hobs/${aldric.id}/new`);
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  await composer.fill(
    [
      "Plan the launch",
      script("delegate_task", {
        key: "ship",
        hob: "Quill",
        brief: "Ship the copy\nfake:tool Bash git push origin feature",
      }),
    ].join("\n"),
  );
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: /Stop/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Stop/ })).toBeHidden();
  await expect(page).toHaveURL(new RegExp(`/hobs/${aldric.id}/threads/`));
  const thread = page.url();

  // Quill asks you, not Aldric: nothing asks in Aldric's chat, and the Inbox has Quill's request.
  await expect(page.getByRole("link", { name: "Inbox, 1 waiting on you" })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("region", { name: /asks permission$/ })).toHaveCount(0);
  await page.getByRole("link", { name: "Inbox, 1 waiting on you" }).click();
  await page
    .getByRole("list", { name: "Requests" })
    .getByRole("link", { name: /Push your work/ })
    .click();
  const detail = page.getByRole("article", { name: "Request from Quill: Push your work" });
  const card = detail.getByRole("region", { name: "Quill asks permission" });
  await expect(card.getByText("git push origin feature", { exact: true })).toBeVisible();

  await card.getByRole("button", { name: "Allow once" }).click();
  await expect(card.getByRole("status")).toHaveText("✓ Allowed once. Quill carries on.");
  const approvals = await api<ReadonlyArray<{ readonly state: string }>>(current, "GET", "/api/approvals");
  expect(approvals.map(({ state }) => state)).toEqual(["approved"]);

  // Open in the chat opens Aldric's thread, where the request was made.
  await detail.getByRole("link", { name: "Open in the chat" }).click();
  await expect(page).toHaveURL(thread);
});
