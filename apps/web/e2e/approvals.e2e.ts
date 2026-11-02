import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import type { Page } from "@playwright/test";
import { emptyDataDir, expect, type Hub, removeDataDir, startHub, test } from "./hub.ts";

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

interface Approval {
  readonly id: string;
  readonly state: string;
  readonly actionDigest: string;
}

// Balanced asks before pushing, and a push to the default branch is high risk. The fake runtime
// makes the scripted call without running it.
const push = (branch: string) => `Ship it\nfake:tool Bash git push origin ${branch}`;

/** A hub where Pip works in one shared folder under Balanced, with its chat open on a fresh page. */
const pipAsksToPush = async (page: Page, branch = "feature") => pipAsks(page, push(branch));

const pipAsks = async (page: Page, prompt: string, safetyPreset = "balanced") => {
  const current = await startHub(dataDir);
  hub = current;
  await api(current, "PATCH", "/api/setup", {
    completed: true,
    connectedProviders: ["claude-code"],
    safetyPreset,
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
  await composer.fill(prompt);
  await composer.press("Enter");
  const card = page.getByRole("region", { name: "Pip asks permission" });
  await expect(card).toBeVisible();
  const thread = page.url().match(/threads\/([^/?#]+)/)?.[1] ?? "";
  return { current, card, thread };
};

// covers PE-003
test("[TC-PE-074] the card shows the exact action and why, and Allow once by keyboard resumes the paused reply", async ({
  page,
}) => {
  const { card } = await pipAsksToPush(page);
  await expect(card).toContainText("Push your work");
  await expect(card.getByText("git push origin feature", { exact: true })).toBeVisible();
  await expect(card.getByRole("checkbox")).toHaveCount(0);
  await expect(card).toContainText("You → Pip");
  await expect(card).toContainText("Sends commits to a remote");
  await expect(page.getByRole("list", { name: "Reply steps" })).toContainText("Waiting for your approval.");

  await expect(card).toContainText("Why now");
  await expect(card).toContainText(/asks|waits/);

  // By keyboard; focus stays in the card once the buttons give way to the outcome.
  await card.getByRole("button", { name: "Allow once" }).focus();
  await page.keyboard.press("Enter");

  await expect(card.getByRole("status")).toHaveText("✓ Allowed once. Pip carries on.");
  await expect(card.getByRole("status")).toBeFocused();
  await expect(card.getByRole("button", { name: "Allow once" })).toBeHidden();
  await expect(page.locator('[data-state="done"]', { hasText: "git push" })).toBeVisible();
  await expect(page.getByText(/^Echo: Ship it/)).toBeVisible();
});

// covers PE-007
test("[TC-PE-078] a push to the default branch is high risk and needs the confirmation box before Allow once", async ({
  page,
}) => {
  const { card } = await pipAsksToPush(page, "main");
  await expect(card).toContainText("High risk · once only");
  // High risk is once only: no Always, and no note about rules, since the check box says why.
  await expect(card.getByRole("button", { name: "Always for this site" })).toHaveCount(0);
  await expect(card).not.toContainText("cannot save a rule");
  const allow = card.getByRole("button", { name: "Allow once" });
  await expect(allow).toBeDisabled();

  const confirm = card.getByRole("checkbox", { name: "I checked this action. Let Pip do it this once." });
  await confirm.focus();
  await page.keyboard.press("Space");
  await expect(confirm).toBeChecked();
  await expect(allow).toBeEnabled();
  await allow.focus();
  await page.keyboard.press("Enter");

  await expect(card.getByRole("status")).toHaveText("✓ Allowed once. Pip carries on.");
  await expect(page.locator('[data-state="done"]', { hasText: "git push" })).toBeVisible();
});

// covers PE-003
test("[TC-PE-075] Deny with a reason works by keyboard and the reply shows the reason", async ({ page }) => {
  // Denying a high-risk push needs no confirmation.
  const { card } = await pipAsksToPush(page, "main");
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
  await expect(card.getByRole("status")).toBeFocused();
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
  await composer.fill(push("feature"));
  await composer.press("Enter");
  const second = page.getByRole("region", { name: "Pip asks permission" }).nth(1);
  await expect(second.getByRole("button", { name: "Allow once" })).toBeVisible();
  await page.getByRole("button", { name: "■ Stop" }).click();
  await expect(second.getByRole("status")).toHaveText("◷ Expired before anyone decided. Nothing ran.");
  await expect(second.getByRole("button", { name: "Allow once" })).toBeHidden();
});

interface Grant {
  readonly rule: unknown;
  readonly lifetime: string;
}

// Balanced asks before deleting files, and Careful before editing them; the fake runtime decides
// the call without running it.
const remove = (file: string) => `Tidy up\nfake:tool Bash rm ${file}`;
const write = (file: string) => `Draft it\nfake:tool Write ${file}`;

/** Sends a prompt once the last reply has ended. */
const sendNext = async (page: Page, prompt: string) => {
  await expect(page.getByRole("button", { name: /Stop/ })).toBeHidden();
  const composer = page.getByRole("textbox", { name: /^Message Pip/ });
  await composer.fill(prompt);
  await composer.press("Enter");
};

// covers PE-007
test("[TC-PE-101] Always shows the rule it saves, saves exactly that rule, and only matching calls skip asking", async ({
  page,
}) => {
  const { current, card } = await pipAsks(page, remove("old.txt"));
  await expect(card).toContainText(/Expires (tomorrow )?at .+ if nobody decides/);
  await card.getByRole("button", { name: "Always for this site" }).click();
  const form = card.getByRole("form", { name: "Always for this site" });
  // A delete's rule names the exact path, never the folder above it, so there is nothing to narrow.
  await expect(form.getByRole("list", { name: "The rule to save" })).toHaveText(
    `Always let Pip delete ${shared}/old.txt`,
  );
  await expect(form.getByRole("radio")).toHaveCount(0);

  // Escape takes the rule back without saving it, with focus on Always.
  await page.keyboard.press("Escape");
  await expect(card.getByRole("button", { name: "Always for this site" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(form.getByRole("button", { name: "Save the rule and allow" })).toBeFocused();
  await page.keyboard.press("Enter");

  await expect(card.getByRole("status")).toHaveText("✓ Allowed, and the rule is saved. Pip carries on.");
  await expect(card.getByRole("status")).toBeFocused();
  const grants = await api<ReadonlyArray<Grant>>(current, "GET", "/api/grants");
  expect(grants.map((grant) => [grant.lifetime, grant.rule])).toEqual([
    ["always", { _tag: "Paths", operation: "delete-files", paths: [`${shared}/old.txt`] }],
  ]);

  // The rule answers the same delete: it runs with no new card.
  const cards = page.getByRole("region", { name: "Pip asks permission" });
  await sendNext(page, remove("old.txt"));
  await expect(page.getByText(/^Echo: Tidy up/)).toHaveCount(2);
  await expect(cards).toHaveCount(1);
  // Another file is not covered, so it asks again.
  await sendNext(page, remove("other.txt"));
  await expect(cards).toHaveCount(2);
});

// covers PE-007
test("[TC-PE-102] Always narrowed to the action's files saves only those files, and another file still asks", async ({
  page,
}) => {
  const { current, card } = await pipAsks(page, write("notes.md"), "careful");
  await card.getByRole("button", { name: "Always for this site" }).click();
  const form = card.getByRole("form", { name: "Always for this site" });
  const rules = form.getByRole("list", { name: "The rule to save" });
  await expect(rules).toHaveText(`Always let Pip create and edit files directly in ${shared}`);
  await expect(form.getByRole("radio", { name: "Every file directly in the folder" })).toBeChecked();
  await form.getByRole("radio", { name: "Only the files of this action" }).check();
  await expect(rules).toHaveText(`Always let Pip create and edit ${shared}/notes.md`);
  await form.getByRole("button", { name: "Save the rule and allow" }).click();

  await expect(card.getByRole("status")).toHaveText("✓ Allowed, and the rule is saved. Pip carries on.");
  const grants = await api<ReadonlyArray<Grant>>(current, "GET", "/api/grants");
  expect(grants.map((grant) => grant.rule)).toEqual([
    { _tag: "Paths", operation: "edit-files", paths: [`${shared}/notes.md`] },
  ]);

  // Another file in the same folder is not covered, so it asks again.
  await sendNext(page, write("other.md"));
  await expect(page.getByRole("region", { name: "Pip asks permission" })).toHaveCount(2);
});

// covers PE-007
test("[TC-PE-125] an Always rule shows in Inbox History and Settings, and removing it there makes the next call ask again", async ({
  page,
}) => {
  const { current, card } = await pipAsks(page, remove("old.txt"));
  await card.getByRole("button", { name: "Always for this site" }).click();
  await card.getByRole("button", { name: "Save the rule and allow" }).click();
  await expect(card.getByRole("status")).toHaveText("✓ Allowed, and the rule is saved. Pip carries on.");
  const chat = page.url();
  const rule = `Always let Pip delete ${shared}/old.txt`;

  // Settings › Permissions lists it with when it was saved and the request that saved it.
  await page.goto(`${current.url}/#/settings`);
  const settings = page.getByRole("region", { name: "Standing rules" });
  await expect(settings.getByRole("listitem")).toHaveCount(1);
  await expect(settings.getByRole("listitem")).toContainText(rule);
  await expect(settings.getByRole("listitem")).toContainText(/Saved .+ · last used .+/);

  // Inbox History lists the same rule; its link opens the request that saved it.
  await page.goto(`${current.url}/#/inbox?tab=history`);
  const history = page.getByRole("region", { name: "Standing rules" });
  await expect(history.getByRole("listitem")).toContainText(rule);
  await history.getByRole("link", { name: `See the request that saved: ${rule}` }).click();
  await expect(page).toHaveURL(/tab=all&request=/);
  await expect(page.getByRole("article", { name: /^Request from Pip/ })).toBeVisible();
  await page.goBack();

  // Remove rule asks first: Escape keeps the rule, with focus back on Remove rule.
  const removeRule = history.getByRole("button", { name: `Remove rule: ${rule}` });
  await removeRule.click();
  const question = history.getByRole("group", { name: `Remove rule: ${rule}` });
  await expect(question).toContainText("Remove this rule? Next time Pip does this, Pip asks you first.");
  await expect(question.getByRole("button", { name: "Keep it" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(question).toBeHidden();
  await expect(removeRule).toBeFocused();
  await removeRule.click();
  await question.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(history.getByText("No standing rules")).toBeVisible();

  // The hub kept it as removed by the user, and the same delete asks again.
  const grants = await api<ReadonlyArray<Grant & { readonly revokeReason: string }>>(
    current,
    "GET",
    "/api/grants?include=all",
  );
  expect(grants.map((grant) => grant.revokeReason)).toEqual(["removed"]);
  await page.goto(chat);
  await sendNext(page, remove("old.txt"));
  await expect(page.getByRole("region", { name: "Pip asks permission" })).toHaveCount(2);
});
