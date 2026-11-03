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
  await page.getByRole("navigation", { name: "Sections" }).getByRole("link", { name: "Usage" }).click();
  await expect(page.getByRole("heading", { name: "Usage" })).toBeVisible();

  // The fake Claude Code reports a session window 38% used and a weekly one 12% used.
  const plans = page.getByRole("region", { name: "Your AI plans" });
  await expect(plans.getByRole("radio", { name: "Claude Code, 62% left" })).toBeChecked();
  await expect(plans.getByText("This window refills in 2 hours.")).toBeVisible();
  await expect(plans.getByText("Current session · 38% used")).toBeVisible();
  await expect(plans.getByText("Weekly · all models · 12% used")).toBeVisible();
  // Fake Codex reports no plan, and the screen says so instead of guessing.
  await plans.getByRole("radio", { name: "Codex, Not reported" }).check({ force: true });
  await expect(plans.getByText("Codex didn't report this plan's limits", { exact: false })).toBeVisible();

  await expect(page.getByRole("region", { name: "Replies per day" })).toContainText("3 replies in the last 7 days");
  const hobs = page.getByRole("region", { name: "Who used your plans" }).getByRole("listitem");
  await expect(hobs).toHaveCount(2);
  await expect(hobs.nth(0)).toContainText("Pip");
  await expect(hobs.nth(0)).toContainText("2 replies");
  await expect(hobs.nth(1)).toContainText("Bramble");
  await expect(hobs.nth(1)).toContainText("1 reply");
  // The shares add up to every hob's tokens.
  const shares = await hobs.evaluateAll((rows) =>
    rows.map((row) => Number(/(\d+)%/.exec(row.textContent ?? "")?.[1] ?? Number.NaN)),
  );
  expect(shares[0]).toBeGreaterThan(shares[1] ?? 100);
  expect((shares[0] ?? 0) + (shares[1] ?? 0)).toBeGreaterThanOrEqual(99);

  // The 30-day period lives in the URL and counts the same replies.
  await page.getByRole("navigation", { name: "Period" }).getByRole("link", { name: "30 days" }).click();
  await expect(page).toHaveURL(/#\/usage\?days=30/);
  await expect(page.getByRole("link", { name: "30 days" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("region", { name: "Replies per day" })).toContainText("3 replies in the last 30 days");
  await expect(hobs).toHaveCount(2);
});

// covers OP-002
test("[TC-OP-074] a hub where no hob has replied says so", async ({ page }) => {
  hub = await startHub(dataDir);
  await api(hub, "PATCH", "/setup", { completed: true });
  await page.goto(`${hub.url}/#/usage?days=30`);
  await expect(page.getByRole("region", { name: "Who used your plans" })).toContainText(
    "No hob replied in the last 30 days.",
  );
  await expect(page.getByRole("region", { name: "Replies per day" })).toContainText("0 replies in the last 30 days");
});
