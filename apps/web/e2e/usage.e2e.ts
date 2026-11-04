import type { Page } from "@playwright/test";
import { emptyDataDir, expect, type Hub, removeDataDir, startHub, test } from "./hub.ts";

let hub: Hub | undefined;
let dataDir = "";

test.beforeEach(() => {
  dataDir = emptyDataDir();
});

test.afterEach(async () => {
  await hub?.stop();
  hub = undefined;
  removeDataDir(dataDir);
});

const api = async <T>(current: Hub, method: string, path: string, body?: unknown): Promise<T> => {
  const response = await fetch(`${current.url}/api${path}`, {
    method,
    headers: { ...current.headers, ...(body !== undefined && { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${method} ${path} answered ${response.status}: ${await response.text()}`);
  return (await response.json()) as T;
};

const summon = (current: Hub, name: string, lookSeed: number) =>
  api<{ id: string }>(current, "POST", "/agents", {
    name,
    role: null,
    roleTitle: "Guide",
    sigil: "assistant",
    hat: null,
    tool: null,
    lookSeed,
    lookColor: "moss",
    runtime: "claude-code",
    model: null,
    effort: null,
    instructions: "",
  });

/** Sends prompts in one new thread of the hob and waits for the fake runtime's echoes to finish. */
const chat = async (current: Hub, hobId: string, ...contents: ReadonlyArray<string>) => {
  const thread = await api<{ id: string }>(current, "POST", `/agents/${hobId}/threads`);
  for (const content of contents) await api(current, "POST", `/threads/${thread.id}/messages`, { content });
  await expect
    .poll(async () => {
      const messages = await api<Array<{ status: string }>>(current, "GET", `/threads/${thread.id}/messages`);
      return messages.length === contents.length * 2 && messages.every((m) => m.status === "complete");
    })
    .toBe(true);
};

// covers OP-002
test("[TC-OP-073] the Usage screen shows each plan's potion and each hob's share over 7 and 30 days", async ({
  page,
}) => {
  hub = await startHub(dataDir);
  const current = hub;
  await api(current, "PATCH", "/setup", { completed: true });
  const pip = await summon(current, "Pip", 7);
  const bramble = await summon(current, "Bramble", 8);
  // Pip's second turn reads back the cache its first wrote, so Pip uses more than Bramble.
  await chat(current, pip.id, "Plan my week", "And the weekend");
  await chat(current, bramble.id, "Hello");

  await page.goto(`${current.url}/#/`);
  // Home's plan line reads the same plan, in the same words, as the Usage screen.
  const planLine = page.getByRole("main").getByRole("link", { name: /^Claude Code plan/ });
  await expect(planLine).toContainText(/62% left · This session · refills \d/);
  await planLine.click();
  await expect(page).toHaveURL(/#\/usage$/);
  await expect(page.getByRole("heading", { name: "Usage" })).toBeVisible();

  // The fake Claude Code reports a session window 38% used and a weekly one 12% used.
  const plans = page.getByRole("region", { name: "Your AI" });
  const providers = plans.getByRole("group", { name: "Provider" });
  await expect(providers.getByRole("button", { name: /Claude Code.*62% left/ })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  const claude = plans.getByRole("region", { name: "Claude Code plan" });
  await expect(claude.getByRole("listitem").nth(0)).toContainText("This session62% left");
  await expect(claude.getByRole("listitem").nth(0)).toContainText("Refills in 2 hours");
  await expect(claude.getByRole("listitem").nth(1)).toContainText("This week88% left");
  await expect(claude).toContainText("Numbers from Claude Code, checked");
  // Fake Codex reports no plan, and the screen says so instead of guessing.
  await providers.getByRole("button", { name: /Codex.*Not reported/ }).click();
  await expect(
    plans
      .getByRole("region", { name: "Codex plan" })
      .getByText("Codex didn't report this plan's limits", { exact: false }),
  ).toBeVisible();

  await expect(page.getByRole("region", { name: "Day by day" })).toContainText("3 replies in the last 7 days");
  const hobs = page.getByRole("region", { name: "Who used what" }).getByRole("listitem");
  await expect(hobs).toHaveCount(2);
  await expect(hobs.nth(0)).toContainText("Pip");
  await expect(hobs.nth(0)).toContainText("2 replies");
  await expect(hobs.nth(1)).toContainText("Bramble");
  await expect(hobs.nth(1)).toContainText("1 reply");
  // The shares add up to exactly 100% of every hob's tokens.
  const shares = await hobs.evaluateAll((rows) =>
    rows.map((row) => Number(/(\d+)%/.exec(row.textContent ?? "")?.[1] ?? Number.NaN)),
  );
  expect(shares[0]).toBeGreaterThan(shares[1] ?? 100);
  expect((shares[0] ?? 0) + (shares[1] ?? 0)).toBe(100);

  // The 30-day period lives in the URL and counts the same replies.
  const period = page.getByRole("radiogroup", { name: "Period" });
  await period.getByRole("radio", { name: "30 days" }).click();
  await expect(page).toHaveURL(/#\/usage\?days=30/);
  await expect(period.getByRole("radio", { name: "30 days" })).toBeChecked();
  await expect(page.getByRole("region", { name: "Day by day" })).toContainText("3 replies in the last 30 days");
  await expect(hobs).toHaveCount(2);
});

// covers OP-002
test("[TC-OP-074] a hub where no hob has replied says so", async ({ page }) => {
  hub = await startHub(dataDir);
  await api(hub, "PATCH", "/setup", { completed: true });
  await page.goto(`${hub.url}/#/usage?days=30`);
  await expect(page.getByRole("region", { name: "Who used what" })).toContainText(
    "No hob replied in the last 30 days.",
  );
  await expect(page.getByRole("region", { name: "Day by day" })).toContainText("0 replies in the last 30 days");
});

/** Answers the plans with the fake Claude Code plan's windows at these percents. */
const planAt = async (page: Page, session: number, week: number) => {
  await page.route("**/api/usage/plans", async (route) => {
    const response = await route.fetch();
    const plans = (await response.json()) as Array<{ runtime: string; meters: Array<{ percent: number }> }>;
    const claude = plans.find((plan) => plan.runtime === "claude-code");
    if (claude?.meters[0]) claude.meters[0].percent = session;
    if (claude?.meters[1]) claude.meters[1].percent = week;
    await route.fulfill({ response, json: plans });
  });
};

/** The Usage report's own request, not the plans beside it. */
const isReport = (url: URL) => url.pathname === "/api/usage";

/** Holds the plans until `release` is called, as a slow provider would. */
const holdPlans = async (page: Page) => {
  let release = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/usage/plans", async (route) => {
    await released;
    await route.continue();
  });
  return release;
};

/** Where a region sits on the page, rounded to whole pixels. */
const boxOf = async (locator: ReturnType<Page["locator"]>) => {
  const box = await locator.boundingBox();
  if (box === null) throw new Error("the region is not on the page");
  return { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) };
};

// covers OP-002
test("[TC-OP-092] Usage and Home keep their places while Claude Code is asked for the plan", async ({ page }) => {
  hub = await startHub(dataDir);
  await api(hub, "PATCH", "/setup", { completed: true });

  let release = await holdPlans(page);
  await page.goto(`${hub.url}/#/usage`);
  // Day by day reads the hub and does not wait for the plan.
  const daily = page.getByRole("region", { name: "Day by day" });
  await expect(daily).toContainText("0 replies in the last 7 days");
  // Claude Code's card waits at its full size, and after a second says what it waits on.
  const card = page.getByRole("region", { name: "Your AI" }).getByRole("region", { name: "Claude Code plan" });
  await expect(card).toHaveAttribute("aria-busy", "true");
  await expect(card.getByRole("status")).toHaveText("Asking Claude Code for your plan…");
  const waitingCard = await boxOf(card);
  const waitingDaily = await boxOf(daily);

  release();
  await expect(card.getByRole("listitem").nth(0)).toContainText("This session62% left");
  await expect(card).toContainText("Numbers from Claude Code, checked");
  expect(await boxOf(card)).toEqual(waitingCard);
  expect(await boxOf(daily)).toEqual(waitingDaily);

  // Home's plan line keeps its tile, title and empty bar, with the wait line where the numbers go.
  await page.unrouteAll();
  release = await holdPlans(page);
  await page.goto(`${hub.url}/#/`);
  await page.reload();
  const line = page.getByRole("main").getByRole("link", { name: /^Claude Code plan/ });
  await expect(line.getByRole("status")).toHaveText("Asking Claude Code for your plan…");
  await expect(line).not.toContainText("Claude Code reports them");
  const waitingLine = await boxOf(line);
  release();
  await expect(line).toContainText(/62% left · This session · refills \d/);
  expect(await boxOf(line)).toEqual(waitingLine);
});

// covers OP-002
test("[TC-OP-093] switching the period keeps the last numbers until the new ones arrive", async ({ page }) => {
  hub = await startHub(dataDir);
  const current = hub;
  await api(current, "PATCH", "/setup", { completed: true });
  const pip = await summon(current, "Pip", 7);
  await chat(current, pip.id, "Plan my week");

  await page.goto(`${current.url}/#/usage`);
  const daily = page.getByRole("region", { name: "Day by day" });
  await expect(daily).toContainText("1 reply in the last 7 days");
  const hobs = page.getByRole("region", { name: "Who used what" }).getByRole("listitem");
  await expect(hobs).toHaveCount(1);

  // The 30-day report is held, so the 7-day numbers stay on screen, named by their own period.
  let release = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let asked = false;
  await page.route(isReport, async (route) => {
    asked = true;
    await released;
    await route.continue();
  });
  await page.getByRole("radiogroup", { name: "Period" }).getByRole("radio", { name: "30 days" }).click();
  await expect.poll(() => asked).toBe(true);
  await expect(daily).toContainText("1 reply in the last 7 days");
  await expect(hobs).toHaveCount(1);
  release();
  await expect(daily).toContainText("1 reply in the last 30 days");
  await expect(hobs).toHaveCount(1);
});

// covers OP-002
test("[TC-OP-077] a plan warns when it runs low and says when paused hobs come back", async ({ page }) => {
  hub = await startHub(dataDir);
  await api(hub, "PATCH", "/setup", { completed: true });

  await planAt(page, 40, 20);
  await page.goto(`${hub.url}/#/usage`);
  const claude = page.getByRole("region", { name: "Claude Code plan" });
  await expect(claude).toContainText("Plenty left");
  await expect(page.getByRole("status").filter({ hasText: "running low" })).toHaveCount(0);

  // From 80% of a window used, the plan runs low and a banner says what happens.
  await page.unrouteAll();
  await planAt(page, 40, 85);
  await page.reload();
  await expect(claude).toContainText("Running low");
  const low = page.getByRole("status").filter({ hasText: "This week on Claude Code is running low" });
  await expect(low).toContainText("15% left. Hobs pause if it runs out");
  await expect(claude.getByRole("listitem").nth(1).locator("[data-slot=progress]")).toHaveAttribute("data-tone", "low");
  // The potion shows the week, in the meter's tone.
  await expect(claude.locator("[data-slot=potion-liquid]")).toHaveAttribute("data-tone", "low");
  // How to save leads to the ways to make the plan last, and takes the keyboard there too.
  await low.getByRole("button", { name: "How to save" }).click();
  await expect(page.getByRole("heading", { name: "Ways to make it last" })).toBeFocused();
  await expect(
    page.getByRole("region", { name: "Ways to make it last" }).getByRole("link", { name: "Open Inbox" }),
  ).toBeVisible();

  // A used-up window pauses the hobs until it refills.
  await page.unrouteAll();
  await planAt(page, 100, 85);
  await page.reload();
  await expect(claude).toContainText(/Paused until \d/);
  const paused = page.getByRole("status").filter({ hasText: "Your hobs are paused" });
  await expect(paused).toContainText("This session on Claude Code is used up. Refills in 2 hours");
  await expect(claude.getByRole("listitem").nth(0)).toContainText("This sessionEmpty");
  await expect(claude.getByRole("listitem").nth(0).locator("[data-slot=progress]")).toHaveAttribute("data-tone", "out");
});

// covers OP-002
test("[TC-OP-091] Who used what splits the period by quest, with the chats outside a quest last", async ({ page }) => {
  hub = await startHub(dataDir);
  await api(hub, "PATCH", "/setup", { completed: true });
  await page.route(isReport, async (route) => {
    const response = await route.fetch();
    const report = (await response.json()) as Record<string, unknown>;
    const quest = { party: 0, chats: 1, replies: 2, unreported: 0 };
    report.quests = [
      { ...quest, questId: null, goal: null, leadName: null, chats: 3, tokens: 2500 },
      { ...quest, questId: "q-launch", goal: "Plan the spring launch", leadName: "Pip", party: 3, tokens: 6300 },
      { ...quest, questId: "q-pricing", goal: "Review the pricing page", leadName: "Rook", party: 2, tokens: 1200 },
    ];
    await route.fulfill({ response, json: report });
  });
  await page.goto(`${hub.url}/#/usage`);

  const who = page.getByRole("region", { name: "Who used what" });
  const split = who.getByRole("radiogroup", { name: "Show" });
  await expect(split.getByRole("radio", { name: "By hob" })).toBeChecked();
  await split.getByRole("radio", { name: "By quest" }).click();
  // The split lives in the URL beside the period.
  await expect(page).toHaveURL(/#\/usage\?by=quest$/);
  const rows = who.getByRole("listitem");
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText("Plan the spring launch");
  await expect(rows.nth(0)).toContainText("Pip's quest · 3 hobs");
  await expect(rows.nth(0)).toContainText("63%");
  await expect(rows.nth(1)).toContainText("Review the pricing page");
  await expect(rows.nth(1)).toContainText("12%");
  await expect(rows.nth(2)).toContainText("Chats without a quest");
  await expect(rows.nth(2)).toContainText("3 chats");
  await expect(rows.nth(2)).toContainText("25%");

  // Picking the period keeps the split.
  await page.getByRole("radiogroup", { name: "Period" }).getByRole("radio", { name: "30 days" }).click();
  await expect(page).toHaveURL(/#\/usage\?days=30&by=quest$/);
  await expect(rows).toHaveCount(3);
});
