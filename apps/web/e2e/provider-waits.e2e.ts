import type { Page, Route } from "@playwright/test";
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

const api = async <A>(current: Hub, method: string, path: string, body?: unknown): Promise<A> => {
  const response = await fetch(`${current.url}${path}`, {
    method,
    headers: { ...current.headers, ...(body !== undefined && { "content-type": "application/json" }) },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${method} ${path} answered ${response.status}: ${await response.text()}`);
  return (await response.json()) as A;
};

/** A hub past onboarding with one hob, Pip, made through the API as Summon makes it. */
const hubWithPip = async (): Promise<{ current: Hub; pipId: string }> => {
  const current = await startHub(dataDir);
  await api(current, "PATCH", "/api/setup", { completed: true, connectedProviders: ["claude-code"] });
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
    instructions: "Write short answers.",
  });
  return { current, pipId: pip.id };
};

/** Holds every request to `url` until `release` is called, as a slow provider would. */
const holdRoute = async (page: Page, url: string) => {
  const held: Array<Route> = [];
  let released = false;
  await page.route(url, async (route) => {
    if (released) return route.continue();
    held.push(route);
  });
  return {
    release: async () => {
      released = true;
      await Promise.all(held.splice(0).map((route) => route.continue()));
    },
  };
};

// covers AG-002
test("[TC-UX-180] a slow model list waits in place in How it thinks, names the provider, then offers Try again", async ({
  page,
}) => {
  test.slow();
  const { current, pipId } = await hubWithPip();
  hub = current;
  const models = await holdRoute(page, "**/api/runtimes/claude-code/models");

  await page.goto(`${current.url}/#/hobs/${pipId}/profile`);
  const thinks = page.getByRole("region", { name: "How Pip thinks" });
  // The model cards and Effort keep their place, Effort disabled, before the provider answers.
  const effort = thinks.getByRole("radiogroup", { name: "Effort" });
  await expect(effort).toBeVisible();
  await expect(effort.getByRole("radio").first()).toBeDisabled();
  // After a second one line names who it waits on; after ten, a slow provider offers Try again.
  await expect(thinks.getByRole("status")).toHaveText("Asking Claude Code for its models…");
  const retry = thinks.getByRole("button", { name: "Try again" });
  await expect(retry).toBeVisible({ timeout: 15_000 });
  await expect(thinks.getByText("Claude Code is slow to answer. Your hobs keep working.")).toBeVisible();

  // Try again asks once more and starts the wait line's clock again; then the provider answers.
  await retry.click();
  await expect(retry).toBeHidden();
  await expect(thinks.getByRole("status")).toHaveText("Asking Claude Code for its models…");
  await models.release();
  await expect(thinks.getByRole("radio", { name: /^Fake Thinker/ })).toBeChecked();
  await expect(thinks.getByRole("status")).toHaveCount(0);
});

// covers AG-001
test("[TC-UX-181] Summon's Ready step keeps its rows and the provider cards while the providers are checked", async ({
  page,
}) => {
  const current = await startHub(dataDir);
  hub = current;
  await api(current, "PATCH", "/api/setup", { completed: true, connectedProviders: ["claude-code"] });
  const runtimes = await holdRoute(page, "**/api/runtimes");

  await page.goto(`${current.url}/#/summon?step=ready`);
  const summary = page.getByRole("definition");
  await expect(summary).toHaveCount(4);
  const ai = page.getByRole("region", { name: "Which AI it thinks with" });
  await expect(ai.getByText("Claude", { exact: true })).toBeVisible();
  await expect(ai.getByRole("status")).toHaveText("Checking your AI providers…");

  await runtimes.release();
  await expect(ai.getByRole("radio", { name: "Claude" })).toBeChecked();
  await expect(summary).toHaveCount(4);
});

// covers AG-001
test("[TC-UX-182] Arrived draws its stage at once while the hobs are read after a reload", async ({ page }) => {
  const { current, pipId } = await hubWithPip();
  hub = current;
  const agents = await holdRoute(page, "**/api/agents");

  await page.goto(`${current.url}/#/hobs/${pipId}/arrived`);
  await expect(page.getByRole("heading", { name: "Try asking" })).toHaveCount(0);
  await expect(page.getByText("Try asking")).toBeVisible();
  await expect(page.getByRole("link", { name: "Summon another" })).toBeVisible();

  await agents.release();
  await expect(page.getByRole("heading", { name: "Pip is here!" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Open Pip's profile" })).toBeVisible();
});
