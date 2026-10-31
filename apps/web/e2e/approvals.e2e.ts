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

// Balanced asks before pushing; the fake runtime makes the scripted call without running it.
const PUSH = "Ship it\nfake:tool Bash git push origin main";

/** A hub where Pip works in one shared folder under Balanced, with its chat open on a fresh page. */
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
  await expect(card).toBeVisible();
  const thread = page.url().match(/threads\/([^/?#]+)/)?.[1] ?? "";
  return { current, card, thread };
};

// covers PE-003
test("[TC-PE-074] the card shows the exact action, and Allow once resumes the paused reply", async ({ page }) => {
  const { card } = await pipAsksToPush(page);
  await expect(card).toContainText("Push your work");
  await expect(card.getByText("git push origin main", { exact: true })).toBeVisible();
  await expect(card).toContainText("You → Pip");
  await expect(card).toContainText("Sends commits to a remote");
  await expect(page.getByRole("list", { name: "Reply steps" })).toContainText("Waiting for your approval.");

  await card.getByRole("button", { name: "Allow once" }).click();

  await expect(card.getByRole("status")).toHaveText("✓ Allowed once. Pip carries on.");
  await expect(card.getByRole("button", { name: "Allow once" })).toBeHidden();
  await expect(page.locator('[data-state="done"]')).toBeVisible();
  await expect(page.getByText(/^Echo: Ship it/)).toBeVisible();
});

// covers PE-003
test("[TC-PE-075] Deny with a reason works by keyboard and the reply shows the reason", async ({ page }) => {
  const { card } = await pipAsksToPush(page);
  await card.getByRole("button", { name: "Deny" }).focus();
  await page.keyboard.press("Enter");
  const reason = card.getByRole("textbox", { name: "Tell Pip why (optional)" });
  await expect(reason).toBeFocused();

  // Escape takes the reason back and returns to Deny.
  await page.keyboard.press("Escape");
  await expect(card.getByRole("button", { name: "Deny" })).toBeFocused();
  await page.keyboard.press("Enter");
  await page.keyboard.type("Not on Fridays");
  await page.keyboard.press("Enter");

  await expect(card.getByRole("status")).toHaveText("✕ Denied: “Not on Fridays”. Pip was told why.");
  const steps = page.getByRole("list", { name: "Reply steps" });
  await expect(steps.locator('[data-state="denied"]')).toContainText("You denied this:");
  await expect(steps.locator('[data-state="denied"]')).toContainText("Not on Fridays");
});

// covers PE-003, PE-007
test("[TC-PE-076] the card follows a decision made elsewhere, and a stopped reply's request expires", async ({
  page,
}) => {
  const { current, card, thread } = await pipAsksToPush(page);
  const [pending] = await api<ReadonlyArray<Approval>>(current, "GET", `/api/threads/${thread}/approvals`);
  if (pending === undefined) throw new Error("No approval request");
  // Another window approves; this page only hears about it.
  await api(current, "POST", `/api/approvals/${pending.id}/decision`, {
    decision: "approve",
    actionDigest: pending.actionDigest,
  });
  await expect(card.getByRole("status")).toHaveText("✓ Allowed once. Pip carries on.");

  // A second request, left pending, expires when its reply is stopped.
  const composer = page.getByRole("textbox", { name: /^Message Pip/ });
  await expect(page.getByRole("button", { name: /Stop/ })).toBeHidden();
  await composer.fill(PUSH);
  await composer.press("Enter");
  const second = page.getByRole("region", { name: "Pip asks permission" }).nth(1);
  await expect(second.getByRole("button", { name: "Allow once" })).toBeVisible();
  await page.getByRole("button", { name: "■ Stop" }).click();
  await expect(second.getByRole("status")).toHaveText("◷ Expired before anyone decided. Nothing ran.");
  await expect(second.getByRole("button", { name: "Allow once" })).toBeHidden();
});
