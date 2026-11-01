import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { emptyDataDir, type Hub, removeDataDir, startHub } from "./hub.ts";

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
    ...(body !== undefined && { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${method} ${path} answered ${response.status}: ${await response.text()}`);
  return (await response.json()) as A;
};

interface Approval {
  readonly id: string;
  readonly state: string;
  readonly actionDigest: string;
}

// Balanced asks before pushing. The fake runtime makes the scripted call without running it.
const PUSH = "Ship it\nfake:tool Bash git push origin feature";

/** A hub where Pip works in one shared folder under Balanced and has asked to push, from its chat. */
const pipAsksToPush = async (page: Page) => {
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
  await composer.fill(PUSH);
  await composer.press("Enter");
  const card = page.getByRole("region", { name: "Pip asks permission" });
  await expect(card.getByRole("button", { name: "Allow once" })).toBeVisible();
  return { current, card };
};

const inboxLink = (page: Page) =>
  page.getByRole("navigation", { name: "Sections" }).getByRole("link", { name: /^Inbox/ });

// covers PE-003, UX-001, UX-005
test("[TC-IN-002] a pending request shows in Needs you, on Home and the rail, and approving it there resumes the turn", async ({
  page,
}) => {
  await pipAsksToPush(page);
  await expect(inboxLink(page)).toHaveAccessibleName("Inbox, 1 request needs you");

  // Home lists it and opens it in the Inbox.
  await page.getByRole("link", { name: "Home", exact: true }).click();
  const needsYou = page.getByRole("region", { name: "Needs you" });
  await expect(needsYou).toContainText("Pip → you");
  await needsYou.getByRole("link", { name: /Push your work/ }).click();

  const list = page.getByRole("list", { name: "Requests" });
  await expect(list).toContainText("Pip · ");
  await expect(list.getByRole("link", { name: /Push your work/ })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("navigation", { name: "Inbox filters" })).toContainText("Needs you1");
  const detail = page.getByRole("article", { name: "Request from Pip: Push your work" });
  await expect(detail).toContainText("expires in 23 h");
  const card = detail.getByRole("region", { name: "Pip asks permission" });
  await expect(card.getByText("git push origin feature", { exact: true })).toBeVisible();

  await card.getByRole("button", { name: "Allow once" }).click();
  await expect(card.getByRole("status")).toHaveText("✓ Allowed once. Pip carries on.");

  // It stays in view with its outcome, Needs you clears once you look again, and History keeps the decision.
  const item = list.getByRole("link", { name: /Push your work/ });
  await expect(item).toContainText("You allowed this");
  await page.getByRole("link", { name: "Needs you" }).click();
  await expect(page.getByText("Nothing needs you")).toBeVisible();
  await page.getByRole("link", { name: "History" }).click();
  const history = page.getByRole("region", { name: "Decision history" });
  await expect(history.locator('[data-state="approved"]')).toContainText("Once");
  await expect(history.locator('[data-state="approved"]')).toContainText("Pip: Push your work");

  // The paused reply went on in its thread.
  await page.getByRole("link", { name: "All" }).click();
  await page.getByRole("link", { name: "Open in the chat" }).click();
  await expect(page.locator('[data-state="done"]', { hasText: "git push" })).toBeVisible();
  await expect(page.getByText(/^Echo: Ship it/)).toBeVisible();
  await expect(inboxLink(page)).toHaveAccessibleName("Inbox");
});

// covers PE-003, UX-004
test("[TC-IN-003] a request decided in the chat updates the open Inbox, and one decided in the Inbox updates the chat", async ({
  page,
  context,
}) => {
  const { current, card } = await pipAsksToPush(page);
  const inbox = await context.newPage();
  await inbox.goto(`${current.url}/#/inbox`);
  const item = inbox.getByRole("list", { name: "Requests" }).getByRole("link", { name: /Push your work/ });
  await expect(item).toContainText("Waiting on you");

  // Denied in the chat: the Inbox hears it from the journal.
  await card.getByRole("button", { name: "Deny" }).click();
  await card.getByRole("button", { name: "Deny" }).click();
  await expect(inbox.getByText("Nothing needs you")).toBeVisible();
  await inbox.getByRole("link", { name: "All" }).click();
  await expect(item).toContainText("You denied this");

  // A second request, approved in the Inbox: the chat's card follows.
  const composer = page.getByRole("textbox", { name: /^Message Pip/ });
  await expect(page.getByRole("button", { name: /Stop/ })).toBeHidden();
  await composer.fill(PUSH);
  await composer.press("Enter");
  const second = page.getByRole("region", { name: "Pip asks permission" }).nth(1);
  await expect(second.getByRole("button", { name: "Allow once" })).toBeVisible();
  await inbox.getByRole("link", { name: "Needs you" }).click();
  await inbox.getByRole("button", { name: "Allow once" }).click();
  await expect(second.getByRole("status")).toHaveText("✓ Allowed once. Pip carries on.");
});

// covers PE-007
test("[TC-IN-004] an expired request shows as expired and cannot be approved", async ({ page }) => {
  const { current } = await pipAsksToPush(page);
  await page.getByRole("button", { name: "■ Stop" }).click();
  await expect(page.getByRole("region", { name: "Pip asks permission" }).getByRole("status")).toHaveText(
    "◷ Expired before anyone decided. Nothing ran.",
  );

  await page.goto(`${current.url}/#/inbox?tab=all`);
  const item = page.getByRole("list", { name: "Requests" }).getByRole("link", { name: /Push your work/ });
  await expect(item).toContainText("Expired");
  await expect(item).toContainText("Expired · nothing ran");
  const detail = page.getByRole("article", { name: "Request from Pip: Push your work" });
  await expect(detail).toContainText("Expired requests can never be approved late.");
  await expect(detail.getByRole("button", { name: "Allow once" })).toHaveCount(0);

  // The hub refuses a late approval too.
  const [expired] = await api<ReadonlyArray<Approval>>(current, "GET", "/api/approvals");
  if (expired === undefined) throw new Error("No approval request");
  expect(expired.state).toBe("expired");
  const late = await fetch(`${current.url}/api/approvals/${expired.id}/decision`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ decision: "approve", actionDigest: expired.actionDigest }),
  });
  expect(late.ok).toBe(false);

  await page.getByRole("link", { name: "History" }).click();
  await expect(page.getByRole("region", { name: "Decision history" }).locator('[data-state="expired"]')).toContainText(
    "Expired",
  );
});
