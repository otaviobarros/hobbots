import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { emptyDataDir, type Hub, removeDataDir, startHub } from "./hub.ts";

// Slice 8's done-when checks in the browser (ADR 015). The hub-level side of the same checks,
// on SQLite and PostgreSQL, is apps/server/test/approvals-end-to-end.test.ts.

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

const api = async <A>(current: Hub, path: string): Promise<A> => {
  // As another window of the app, on the hub's own origin: approvals answer only the user (PE-006).
  const response = await fetch(`${current.url}${path}`, { headers: { origin: current.url } });
  if (!response.ok) throw new Error(`GET ${path} answered ${response.status}: ${await response.text()}`);
  return (await response.json()) as A;
};

const setUp = async (current: Hub, method: string, path: string, body: unknown) => {
  const response = await fetch(`${current.url}${path}`, {
    method,
    headers: { origin: current.url, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${method} ${path} answered ${response.status}: ${await response.text()}`);
  return (await response.json()) as { readonly id: string };
};

interface Approval {
  readonly id: string;
  readonly state: string;
  readonly lifetime: string | null;
  readonly denyReason: string | null;
}

interface Grant {
  readonly approvalId: string;
  readonly lifetime: string;
  readonly rule: { readonly _tag: string; readonly operation: string; readonly paths: ReadonlyArray<string> };
}

// Balanced asks before pushing and before deleting files. The fake runtime makes the scripted call
// without running it.
const PUSH = "Ship it\nfake:tool Bash git push origin feature";
const remove = (file: string) => `Tidy up\nfake:tool Bash rm ${file}`;

/** A hub where Pip works in one shared folder under Balanced, with Pip's new chat open. */
const pipsChat = async (page: Page) => {
  const current = await startHub(dataDir);
  hub = current;
  await setUp(current, "PATCH", "/api/setup", {
    completed: true,
    connectedProviders: ["claude-code"],
    safetyPreset: "balanced",
    approvedFolders: [shared],
  });
  const pip = await setUp(current, "POST", "/api/agents", {
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
  return current;
};

/** Sends a prompt once the last reply has ended, and returns the card it asks with. */
const ask = async (page: Page, prompt: string) => {
  await expect(page.getByRole("button", { name: /Stop/ })).toBeHidden();
  const cards = page.getByRole("region", { name: "Pip asks permission" });
  const before = await cards.count();
  const composer = page.getByRole("textbox", { name: /^Message Pip/ });
  await composer.fill(prompt);
  await composer.press("Enter");
  const card = cards.nth(before);
  await expect(card.getByRole("button", { name: "Allow once" })).toBeVisible();
  return card;
};

const replySteps = (page: Page) => page.getByRole("list", { name: "Reply steps" });

/** The request waiting in the Inbox, opened in its own page as another window of the app. */
const inInbox = async (inbox: Page, current: Hub, title: RegExp) => {
  await inbox.goto(`${current.url}/#/inbox`);
  await inbox.getByRole("list", { name: "Requests" }).getByRole("link", { name: title }).click();
  return inbox.getByRole("article", { name: /^Request from Pip/ }).getByRole("region", { name: "Pip asks permission" });
};

const saveAlways = async (card: Locator) => {
  await card.getByRole("button", { name: "Always for this site" }).click();
  await card.getByRole("button", { name: "Save the rule and allow" }).click();
};

const denyWith = async (card: Locator, reason: string) => {
  await card.getByRole("button", { name: "Deny" }).click();
  await card.getByRole("textbox", { name: "Tell Pip why (optional)" }).fill(reason);
  await card.getByRole("button", { name: "Deny" }).click();
};

// covers PE-003, PE-007
test("[TC-PE-129] double-clicking Allow once or Save the rule runs the action once and saves one rule", async ({
  page,
}) => {
  const current = await pipsChat(page);

  const push = await ask(page, PUSH);
  await push.getByRole("button", { name: "Allow once" }).dblclick();
  await expect(push.getByRole("status")).toHaveText("✓ Allowed once. Pip carries on.");
  await expect(page.getByText(/^Echo: Ship it/)).toBeVisible();
  // One push step, run once.
  await expect(replySteps(page).locator('[data-state="done"]', { hasText: "git push" })).toHaveCount(1);

  const tidy = await ask(page, remove("old.txt"));
  await tidy.getByRole("button", { name: "Always for this site" }).click();
  await tidy.getByRole("button", { name: "Save the rule and allow" }).dblclick();
  await expect(tidy.getByRole("status")).toHaveText("✓ Allowed, and the rule is saved. Pip carries on.");
  await expect(page.getByText(/^Echo: Tidy up/)).toBeVisible();

  const approvals = await api<ReadonlyArray<Approval>>(current, "/api/approvals");
  expect(approvals.map(({ state, lifetime }) => [state, lifetime])).toEqual([
    ["approved", "once"],
    ["approved", "always"],
  ]);
  expect(await api<ReadonlyArray<Grant>>(current, "/api/grants?include=all")).toHaveLength(1);
});

// covers PE-003, PE-007, UX-004
test("[TC-IN-018] Always and Deny with a reason give the same result from the Inbox as from the chat", async ({
  page,
  context,
}) => {
  const current = await pipsChat(page);
  const inbox = await context.newPage();

  // Always: once from the chat's card, once from the Inbox's.
  await saveAlways(await ask(page, remove("old.txt")));
  const fromInbox = await ask(page, remove("new.txt"));
  await saveAlways(await inInbox(inbox, current, /Delete/));
  const saved = "✓ Allowed, and the rule is saved. Pip carries on.";
  await expect(page.getByRole("region", { name: "Pip asks permission" }).first().getByRole("status")).toHaveText(saved);
  await expect(fromInbox.getByRole("status")).toHaveText(saved);
  await expect(inbox.getByRole("article", { name: /^Request from Pip/ }).getByRole("status")).toHaveText(saved);
  await expect(replySteps(page).locator('[data-state="done"]', { hasText: "rm " })).toHaveCount(2);

  // Each saved the same kind of rule, for its own file, and History lists both.
  const grants = await api<ReadonlyArray<Grant>>(current, "/api/grants");
  expect(grants.map(({ lifetime, rule }) => [lifetime, rule])).toEqual([
    ["always", { _tag: "Paths", operation: "delete-files", paths: [`${shared}/old.txt`] }],
    ["always", { _tag: "Paths", operation: "delete-files", paths: [`${shared}/new.txt`] }],
  ]);
  await inbox.goto(`${current.url}/#/inbox?tab=history`);
  const rules = inbox.getByRole("region", { name: "Standing rules" });
  await expect(rules.getByRole("listitem")).toHaveCount(2);
  await expect(rules).toContainText(`Always let Pip delete ${shared}/old.txt`);
  await expect(rules).toContainText(`Always let Pip delete ${shared}/new.txt`);

  // Deny with a reason: once from the chat's card, once from the Inbox's.
  await denyWith(await ask(page, PUSH), "Not on Fridays");
  const deniedInInbox = await ask(page, PUSH);
  await denyWith(await inInbox(inbox, current, /Push your work/), "Not on Fridays");
  const denied = "✕ Denied: “Not on Fridays”. Pip was told why.";
  await expect(deniedInInbox.getByRole("status")).toHaveText(denied);
  await expect(page.getByRole("region", { name: "Pip asks permission" }).nth(2).getByRole("status")).toHaveText(denied);
  // Both replies tell the hob why.
  const refused = replySteps(page).locator('[data-state="denied"]');
  await expect(refused).toHaveCount(2);
  for (const step of await refused.all()) await expect(step).toContainText(/You denied this:.*Not on Fridays/);

  const approvals = await api<ReadonlyArray<Approval>>(current, "/api/approvals");
  expect(approvals.map(({ state, lifetime, denyReason }) => [state, lifetime, denyReason])).toEqual([
    ["approved", "always", null],
    ["approved", "always", null],
    ["denied", null, "Not on Fridays"],
    ["denied", null, "Not on Fridays"],
  ]);
});
