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
  await expect(page.getByText(/^Claude Code plan · 62% left · This session · refills \d/)).toBeVisible();
  await page.getByRole("navigation", { name: "Sections" }).getByRole("link", { name: "Usage" }).click();
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

/** Answers the Usage report with the fake Claude Code plan's windows at these percents. */
const planAt = async (page: Page, session: number, week: number) => {
  await page.route("**/api/usage**", async (route) => {
    const response = await route.fetch();
    const report = (await response.json()) as { plans: Array<{ runtime: string; meters: Array<{ percent: number }> }> };
    const claude = report.plans.find((plan) => plan.runtime === "claude-code");
    if (claude?.meters[0]) claude.meters[0].percent = session;
    if (claude?.meters[1]) claude.meters[1].percent = week;
    await route.fulfill({ response, json: report });
  });
};

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
