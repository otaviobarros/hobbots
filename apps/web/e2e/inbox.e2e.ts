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

/** The chief of the hobs on the rail, which raises its lantern while a request needs you. */
const chief = (page: Page) =>
  page.getByRole("navigation", { name: "Sections" }).getByRole("link", { name: /^Hobbots/ });

// covers PE-003, UX-001, UX-005
test("[TC-IN-002] a pending request shows in Needs you, on Home and the rail, and approving it there resumes the turn", async ({
  page,
}) => {
  const { current } = await pipAsksToPush(page);
  await expect(inboxLink(page)).toHaveAccessibleName("Inbox, 1 waiting on you");

  // The chief raises its lantern as soon as the request arrives, and leads to the Inbox.
  await expect(chief(page)).toHaveAccessibleName("Hobbots inbox, something needs you");
  await chief(page).click();
  await expect(page.getByRole("list", { name: "Requests" })).toContainText("Push your work");

  // Home's tray holds it, and Open Inbox leads to it there.
  await page.getByRole("link", { name: "Home", exact: true }).click();
  const needsYou = page.getByRole("region", { name: "Needs you", exact: true });
  await expect(needsYou.getByRole("region", { name: "Needs you, 1 of 1" })).toContainText("git push origin feature");
  await needsYou.getByRole("link", { name: "Open Inbox" }).click();

  const list = page.getByRole("list", { name: "Requests" });
  await list.getByRole("link", { name: /Push your work/ }).click();
  // Its group is Pip's chat, named by the short label with the thread as its detail.
  await expect(list.locator('[title^="Pip · "]')).toHaveCount(1);
  await expect(list.getByRole("link", { name: /Push your work/ })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("tablist", { name: "Inbox filters" })).toContainText("Needs you1");
  const detail = page.getByRole("article", { name: "Request from Pip: Push your work" });
  await expect(detail).toContainText("expires in 23 hours");
  const card = detail.getByRole("region", { name: "Pip asks permission" });
  // The exact action shows once, above the facts, and the decision under them.
  await expect(detail.getByText("git push origin feature", { exact: true })).toHaveCount(1);

  // At a 960px window the list and the request hold side by side, with nothing cut off.
  await page.setViewportSize({ width: 960, height: 800 });
  const aside = await page.getByRole("complementary", { name: "Inbox" }).boundingBox();
  const shown = await detail.boundingBox();
  const allow = await card.getByRole("button", { name: "Allow once" }).boundingBox();
  if (aside === null || shown === null || allow === null) throw new Error("The Inbox is not laid out");
  expect(aside.x + aside.width).toBeLessThanOrEqual(shown.x);
  expect(shown.x + shown.width).toBeLessThanOrEqual(960);
  expect(allow.x + allow.width).toBeLessThanOrEqual(960);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(960);

  await card.getByRole("button", { name: "Allow once" }).click();
  await expect(card.getByRole("status")).toHaveText("✓ Allowed once. Pip carries on.");

  // It stays in view with its outcome, Needs you clears once you look again, and History keeps the decision.
  const item = list.getByRole("link", { name: /Push your work/ });
  await expect(item).toContainText("You allowed this");
  await page.getByRole("tab", { name: /^Needs you/ }).click();
  await expect(page.getByText("Nothing needs you")).toBeVisible();
  await page.getByRole("tab", { name: "History" }).click();
  const history = page.getByRole("region", { name: "Decision history" });
  await expect(history.locator('[data-state="approved"]')).toContainText("Once");
  await expect(history.locator('[data-state="approved"]')).toContainText("Pip: Push your work");

  // The arrow keys move between the tabs, and the address follows.
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByRole("tab", { name: /^Needs you/ })).toHaveAttribute("aria-selected", "true");
  await expect(page).toHaveURL(/tab=needs/);

  // A link to the decided request still opens it in Needs you, and the paused reply went on in its thread.
  const [decided] = await api<ReadonlyArray<Approval>>(current, "GET", "/api/approvals");
  if (decided === undefined) throw new Error("No approval request");
  await page.goto(`${current.url}/#/inbox?tab=needs&request=${decided.id}`);
  await expect(list.getByRole("link", { name: /Push your work/ })).toContainText("You allowed this");
  await page.getByRole("link", { name: "Open in the chat" }).click();
  await expect(page.locator('[data-state="done"]', { hasText: "git push" })).toBeVisible();
  await expect(page.getByText(/^Echo: Ship it/)).toBeVisible();
  await expect(inboxLink(page)).toHaveAccessibleName("Inbox");
  await expect(chief(page)).toHaveAccessibleName(/^Hobbots home/);
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
  await expect(item).toContainText("Expires in 23 hours");

  // Denied in the chat: the Inbox hears it from the journal and keeps it in view with its outcome.
  await card.getByRole("button", { name: "Deny" }).click();
  await card.getByRole("button", { name: "Deny" }).click();
  await expect(item).toContainText("You denied this");
  await expect(inbox.getByRole("article").getByRole("button", { name: "Allow once" })).toHaveCount(0);
  await inbox.getByRole("tab", { name: /^Needs you/ }).click();
  await expect(inbox.getByText("Nothing needs you")).toBeVisible();

  // A second request, approved in the Inbox: the chat's card follows.
  const composer = page.getByRole("textbox", { name: /^Message Pip/ });
  await expect(page.getByRole("button", { name: /Stop/ })).toBeHidden();
  await composer.fill(PUSH);
  await composer.press("Enter");
  const second = page.getByRole("region", { name: "Pip asks permission" }).nth(1);
  await expect(second.getByRole("button", { name: "Allow once" })).toBeVisible();
  await inbox.getByRole("tab", { name: /^Needs you/ }).click();
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

  // A link to it, as from History's standing rules, opens it in Needs you.
  const [closed] = await api<ReadonlyArray<Approval>>(current, "GET", "/api/approvals");
  await page.goto(`${current.url}/#/inbox?tab=needs&request=${closed?.id}`);
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
    headers: { ...current.headers, "content-type": "application/json" },
    body: JSON.stringify({ decision: "approve", actionDigest: expired.actionDigest }),
  });
  expect(late.ok).toBe(false);
  expect(await late.text()).toContain("ApprovalClosed");
  // Read on its own, as the Inbox does once it leaves the list, it is still expired.
  expect(await api<Approval>(current, "GET", `/api/approvals/${expired.id}`)).toMatchObject({ state: "expired" });

  await page.getByRole("tab", { name: "History" }).click();
  await expect(page.getByRole("region", { name: "Decision history" }).locator('[data-state="expired"]')).toContainText(
    "Expired",
  );
});

// covers PE-003, UX-005
test("[TC-IN-011] the open request keeps its place when it cannot be read on its own, and Try again shows it", async ({
  page,
}) => {
  const { current } = await pipAsksToPush(page);
  const [asked] = await api<ReadonlyArray<Approval>>(current, "GET", "/api/approvals");
  if (asked === undefined) throw new Error("No approval request");
  // As if newer decisions had pushed it out of the list: the list holds another request instead,
  // and reading it on its own fails.
  await page.route(`${current.url}/api/approvals`, (route) =>
    route.fulfill({ json: [{ ...asked, id: "other-request" }] }),
  );
  const detail = `${current.url}/api/approvals/${asked.id}`;
  await page.route(detail, (route) => route.fulfill({ status: 503, body: "" }));

  // Loaded afresh, so the app reads the list through the routes above.
  await page.goto(`${current.url}/#/inbox?tab=needs&request=${asked.id}`);
  await page.reload();
  const failed = page.getByRole("main").getByRole("alert");
  await expect(failed).toContainText("could not read this request", { timeout: 20_000 });
  await expect(page.getByRole("list", { name: "Requests" }).locator('[aria-current="page"]')).toHaveCount(0);
  expect(page.url()).toContain(`request=${asked.id}`);

  await page.unroute(detail);
  await failed.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("article", { name: "Request from Pip: Push your work" })).toBeVisible();
  expect(page.url()).toContain(`request=${asked.id}`);
});

/**
 * Stands in for the desktop app's preload bridge: `window.openRequest` plays the main process
 * asking the window to show a request, as a click on its system notification does.
 */
const asDesktop = () => {
  const page = window as unknown as Record<string, unknown>;
  let listener: ((requestId: string) => void) | undefined;
  page.hobbots = {
    onOpenRequest: (next: (requestId: string) => void) => {
      listener = next;
      return () => {
        listener = undefined;
      };
    },
  };
  page.openRequest = (requestId: string) => listener?.(requestId);
};

// covers PE-003, UX-001
test("[TC-IN-014] the desktop app opens a request in the Inbox when its notification is clicked", async ({ page }) => {
  await page.addInitScript(asDesktop);
  const { current } = await pipAsksToPush(page);
  const [asked] = await api<ReadonlyArray<Approval>>(current, "GET", "/api/approvals");
  if (asked === undefined) throw new Error("No approval request");

  await page.evaluate((id) => (window as unknown as { openRequest: (id: string) => void }).openRequest(id), asked.id);
  await expect(page.getByRole("article", { name: "Request from Pip: Push your work" })).toBeVisible();
  expect(page.url()).toContain(`request=${asked.id}`);
  expect(page.url()).toContain("tab=needs");
});

// covers UX-001
test("[TC-UX-090] the count chips on Home filter the scene to the hobs in that state", async ({ page }) => {
  const { current } = await pipAsksToPush(page);
  await api(current, "POST", "/api/agents", {
    name: "Bram",
    role: "assistant",
    roleTitle: "Assistant",
    sigil: "assistant",
    hat: "pointed",
    tool: "none",
    lookSeed: 1200,
    lookColor: "moss",
    runtime: "claude-code",
    model: null,
    effort: null,
    instructions: "",
  });
  await page.getByRole("link", { name: "Home", exact: true }).click();
  const scene = page.getByRole("region", { name: "Your hobs right now" });
  const chips = scene.getByRole("radiogroup", { name: "Show hobs" });
  await expect(chips.getByRole("radio")).toHaveText(["All2", "Need you1", "Resting1"]);
  await expect(chips.getByRole("radio", { name: "All 2" })).toBeChecked();
  // A hob's stage spot holds its bubble, sprite and name; a chip that leaves it out dims it.
  const spot = (name: RegExp) => scene.getByRole("button", { name }).locator("..");

  await chips.getByRole("radio", { name: "Need you 1" }).click();
  await expect(spot(/^Pip, /)).toHaveCSS("opacity", "1");
  await expect(spot(/^Bram, /)).toHaveCSS("opacity", "0.35");

  await chips.getByRole("radio", { name: "Resting 1" }).click();
  await expect(spot(/^Pip, /)).toHaveCSS("opacity", "0.35");
  await expect(spot(/^Bram, /)).toHaveCSS("opacity", "1");

  await chips.getByRole("radio", { name: "All 2" }).click();
  await expect(spot(/^Pip, /)).toHaveCSS("opacity", "1");
});

// covers UX-001, PE-003
test("[TC-UX-093] Home's tray decides a request where it waits, then says all clear", async ({ page }) => {
  await pipAsksToPush(page);
  await page.getByRole("link", { name: "Home", exact: true }).click();
  const needsYou = page.getByRole("region", { name: "Needs you", exact: true });
  const tray = needsYou.getByRole("region", { name: "Needs you, 1 of 1" });
  await expect(tray).toContainText("Pip asks to");
  await expect(needsYou.getByText("All clear")).toHaveCount(0);

  await tray.getByRole("button", { name: "Allow once" }).click();
  await expect(tray).toBeHidden();
  await expect(needsYou).toContainText("All clear");
  await expect(needsYou).toContainText("Nothing needs you. Your hobs will ask here first when something does.");

  // The Inbox records the decision as made there, and See history opens it.
  await needsYou.getByRole("link", { name: "See history" }).click();
  await expect(page).toHaveURL(/#\/inbox\?tab=history$/);
  const history = page.getByRole("region", { name: "Decision history" });
  await expect(history.locator('[data-state="approved"]')).toContainText("in the Inbox");
});

// covers IN-001, PE-003, PE-007, UX-005
test("[TC-IN-492] Needs you works from the keyboard: ↑ ↓ and J K move, A allows once, D denies, and A waits for the high-risk box", async ({
  page,
}) => {
  const { current } = await pipAsksToPush(page);
  // A second chat asks to push to the default branch, which is high risk and so leads the list.
  const pipId = page.url().match(/hobs\/([^/?#]+)/)?.[1] ?? "";
  await page.goto(`${current.url}/#/hobs/${pipId}/new`);
  const composer = page.getByRole("textbox", { name: /^Message Pip/ });
  await composer.fill("Ship it\nfake:tool Bash git push origin main");
  await composer.press("Enter");
  await expect(
    page.getByRole("region", { name: "Pip asks permission" }).getByText("High risk · once only"),
  ).toBeVisible();

  await page.goto(`${current.url}/#/inbox`);
  const aside = page.getByRole("complementary", { name: "Inbox" });
  await expect(aside).toContainText("↑↓move");
  await expect(aside).toContainText("Aallow once");
  await expect(aside).toContainText("Ddeny");
  const rows = page.getByRole("list", { name: "Requests" }).getByRole("link");
  await expect(rows).toHaveCount(2);
  const detail = page.getByRole("article", { name: "Request from Pip: Push your work" });
  const risky = rows.nth(0);
  const plain = rows.nth(1);

  // ↓ and ↑, J and K move the selection, and focus with it, holding at either end of the list.
  await risky.click();
  await expect(risky).toHaveAttribute("aria-current", "page");
  await expect(detail).toContainText("git push origin main");
  await page.keyboard.press("ArrowDown");
  await expect(plain).toHaveAttribute("aria-current", "page");
  await expect(plain).toBeFocused();
  await expect(detail).toContainText("git push origin feature");
  await page.keyboard.press("ArrowDown");
  await expect(plain).toHaveAttribute("aria-current", "page");
  await page.keyboard.press("k");
  await expect(risky).toHaveAttribute("aria-current", "page");
  await expect(risky).toBeFocused();
  await page.keyboard.press("j");
  await expect(plain).toHaveAttribute("aria-current", "page");
  await page.keyboard.press("ArrowUp");
  await expect(risky).toHaveAttribute("aria-current", "page");
  // The list is one stop for Tab: only the selected row takes it.
  await expect(risky).toHaveAttribute("tabindex", "0");
  await expect(plain).toHaveAttribute("tabindex", "-1");

  // A on a high-risk request allows nothing until its box is ticked; it moves focus to the box.
  const card = detail.getByRole("region", { name: "Pip asks permission" });
  const confirm = card.getByRole("checkbox", { name: "I checked this action. Let Pip do it this once." });
  await page.keyboard.press("a");
  await expect(confirm).toBeFocused();
  await expect(confirm).not.toBeChecked();
  await expect(card.getByRole("button", { name: "Allow once" })).toBeDisabled();
  await page.keyboard.press("Space");
  await expect(confirm).toBeChecked();
  await page.keyboard.press("a");
  await expect(card.getByRole("status")).toHaveText("✓ Allowed once. Pip carries on.");

  // The decided request goes last, so ↑ reaches the other one, and D opens Deny with its reason box.
  await page.keyboard.press("ArrowUp");
  await expect(detail).toContainText("git push origin feature");
  await page.keyboard.press("d");
  const reason = card.getByRole("textbox", { name: "Tell Pip why (optional)" });
  await expect(reason).toBeFocused();
  // Typed into the reason box, A and D are letters, not shortcuts.
  await page.keyboard.type("Not today");
  await expect(reason).toHaveValue("Not today");
  await page.keyboard.press("Enter");
  await expect(card.getByRole("status")).toHaveText("✕ Denied: “Not today”. Pip was told why.");
});
