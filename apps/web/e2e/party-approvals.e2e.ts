import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { emptyDataDir, expect, type Hub, removeDataDir, startHub, test } from "./hub.ts";

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
    // As the hub's window, with its key: approvals answer only the user (PE-006).
    headers: { ...current.headers, ...(body !== undefined && { "content-type": "application/json" }) },
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

  // Quill asks you, not Aldric: the Inbox has Quill's request, and Aldric's chat shows it in its
  // Needs-you tray, never as one of Aldric's own (#698).
  await expect(page.getByRole("link", { name: "Inbox, 1 waiting on you" })).toBeVisible({ timeout: 20_000 });
  const tray = page.getByRole("region", { name: /^Needs you/ });
  await expect(tray.getByRole("region", { name: "Quill asks permission" })).toHaveCount(1);
  await expect(page.getByRole("region", { name: "Aldric asks permission" })).toHaveCount(0);
  await page.getByRole("link", { name: "Inbox, 1 waiting on you" }).click();
  // It waits under Aldric's quest, as asked by Quill through Aldric.
  const requests = page.getByRole("list", { name: "Requests" });
  await expect(requests).toContainText("Aldric's quest · ");
  await expect(requests).toContainText("You → Aldric → Quill");
  // By urgency lists it on its own, naming its quest, and the choice stays after a reload.
  await page.getByRole("radio", { name: "By urgency" }).click();
  await expect(requests).not.toContainText("Aldric's quest · ");
  await expect(requests.getByRole("link", { name: /Push your work/ })).toContainText("· Aldric's quest");
  await page.reload();
  await expect(page.getByRole("radio", { name: "By urgency" })).toHaveAttribute("aria-checked", "true");
  await page.getByRole("radio", { name: "By quest" }).click();
  await expect(requests).toContainText("Aldric's quest · ");
  await requests.getByRole("link", { name: /Push your work/ }).click();
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

// Issue #698: Nettle's delete waited five minutes in the Inbox while his Task read active and
// nothing in the Quest said why. The hub-level side is apps/server/test/member-approvals.test.ts.
// covers PE-003, PE-006, OR-002, UX-002
test("[TC-PE-445] a party member's request shows in the chat's tray and on its Task in the Quest tab, Allow once there lets the member finish, and the Inbox shows it settled", async ({
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
  await hobNamed(current, "Nettle", 4821);

  // Aldric brings in Nettle, whose Task deletes a file, which Balanced asks you about.
  await page.goto(`${current.url}/#/hobs/${aldric.id}/new`);
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  await composer.fill(
    [
      "Tidy the scratch folder",
      script("delegate_task", {
        key: "tidy",
        hob: "Nettle",
        brief: [
          "Remove the notes",
          `fake:tool Bash rm ${shared}/tmp-notes.txt`,
          script("complete_task", { key: "tidied", summary: "Notes removed" }),
        ].join("\n"),
      }),
    ].join("\n"),
  );
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: /Stop/ })).toBeHidden();

  // Aldric's Quest card names what Nettle's Task waits on, and the tray holds the request itself.
  const card = page.getByRole("region", { name: "Aldric's work on Tidy the scratch folder" });
  const row = card.getByRole("button", { name: "Look inside Remove the notes" });
  await expect(row).toContainText("Nettle · waiting on your approval: Delete files", { timeout: 20_000 });
  await expect(row).toContainText("Needs you");
  const inTray = page
    .getByRole("region", { name: /^Needs you/ })
    .getByRole("region", { name: "Nettle asks permission" });
  await expect(inTray.getByText(`rm ${shared}/tmp-notes.txt`, { exact: true })).toBeVisible();

  // The Task's drawer opens on what waits on your approval.
  await row.click();
  const drawer = page.getByRole("complementary", { name: "Remove the notes, Task details" });
  await expect(drawer.getByRole("region", { name: "Nettle asks permission" })).toBeVisible();
  await drawer.getByRole("button", { name: "Close" }).click();

  // The Quest tab, open beside the chat while the work runs, shows it under the Task too, and
  // Allow once there decides the same request.
  await expect(page.getByRole("tab", { name: "Quest" })).toHaveAttribute("aria-selected", "true");
  const room = page.getByRole("region", { name: "Control room for Tidy the scratch folder" });
  await expect(room.getByRole("button", { name: /Nettle · Remove the notes/ })).toContainText("waiting on you");
  const inRoom = room.getByRole("region", { name: "Nettle asks permission" });
  await inRoom.getByRole("button", { name: "Allow once" }).click();
  await expect(inRoom.getByRole("status")).toHaveText("✓ Allowed once. Nettle carries on.");

  // Nettle goes on and finishes. Nothing waits on you any more, and the card says how it ended.
  await expect(room.getByRole("button", { name: /Nettle · Remove the notes/ })).toContainText("Done", {
    timeout: 20_000,
  });
  await expect(page.getByRole("button", { name: "Allow once" })).toHaveCount(0);
  await expect(inTray).toBeHidden();
  const approvals = await api<ReadonlyArray<{ readonly state: string; readonly decidedVia: string | null }>>(
    current,
    "GET",
    "/api/approvals",
  );
  expect(approvals.map(({ state, decidedVia }) => [state, decidedVia])).toEqual([["approved", "chat"]]);

  // The Inbox shows the request settled.
  await page.goto(`${current.url}/#/inbox`);
  await expect(page.getByRole("link", { name: /^Inbox, \d+ waiting on you/ })).toHaveCount(0);
  await page.getByRole("tab", { name: "History" }).click();
  await expect(page.getByRole("region", { name: "Decision history" }).locator('[data-state="approved"]')).toHaveCount(
    1,
  );
});
