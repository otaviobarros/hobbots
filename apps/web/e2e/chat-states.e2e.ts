import { expect, type Page, test } from "@playwright/test";
import { emptyDataDir, type Hub, removeDataDir, startHub } from "./hub.ts";

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
    ...(body !== undefined && { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${method} ${path} answered ${response.status}: ${await response.text()}`);
  return (await response.json()) as A;
};

type Reply = { readonly role: string; readonly content: string; readonly status: string };

/** A hub with setup done and Pip, the hob these tests talk to. */
const hubWithPip = async (env: Record<string, string> = {}) => {
  const current = await startHub(dataDir, env);
  hub = current;
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
    instructions: "",
  });
  return { current, pip };
};

const send = async (page: Page, text: string) => {
  const composer = page.getByRole("textbox", { name: /^Message Pip/ });
  await composer.fill(text);
  await composer.press("Enter");
};

const replies = async (current: Hub, page: Page) => {
  const thread = page.url().match(/threads\/([^/?#]+)/)?.[1];
  const messages = await api<ReadonlyArray<Reply>>(current, "GET", `/api/threads/${thread}/messages`);
  return messages.filter((m) => m.role === "assistant");
};

// The fake runtime writes one word every 40 ms.
const LONG_PROMPT = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ");

// covers CH-004
test("[TC-CH-090] a streaming reply shows the steps the runtime reports", async ({ page }) => {
  const { current, pip } = await hubWithPip();
  await page.goto(`${current.url}/#/hobs/${pip.id}/new`);
  await send(page, LONG_PROMPT);

  const steps = page.getByRole("list", { name: "Reply steps" });
  await expect(steps.getByRole("listitem")).toHaveText(/Thinking/);
  await expect(steps.getByRole("listitem")).toHaveAttribute("data-state", "done");
  // Steps are live only: the finished reply leaves none behind.
  await expect(page.getByText(`Echo: ${LONG_PROMPT}`)).toBeVisible();
  await expect(steps).toBeHidden();
});

// covers CH-004, CH-007
test("[TC-CH-091] a reply the provider cut off says why, and Continue resumes it in the same message", async ({
  page,
}) => {
  const { current, pip } = await hubWithPip();
  await page.goto(`${current.url}/#/hobs/${pip.id}/new`);
  await send(page, "fake:cut-off please");

  await expect(
    page.getByText("Answer cut off: Claude stopped responding. Nothing was lost before this point."),
  ).toBeVisible();
  const [cut] = await replies(current, page);
  expect(cut?.status).toBe("interrupted");

  await page.getByRole("button", { name: "Continue from here" }).click();
  await expect(page.getByRole("button", { name: "Continue from here" })).toBeHidden();
  await expect.poll(async () => (await replies(current, page)).map((r) => r.status)).toEqual(["complete"]);
  const [resumed] = await replies(current, page);
  // The same message grows: what was written before the cut stays at its start.
  expect(resumed?.content.startsWith(cut?.content ?? "")).toBe(true);
  expect(resumed?.content.length).toBeGreaterThan(cut?.content.length ?? 0);
  await expect(page.getByText(/Answer cut off/)).toBeHidden();
});

// covers CH-004
test("[TC-CH-092] a provider limit says when the allowance refills and can be continued", async ({ page }) => {
  const { current, pip } = await hubWithPip();
  await page.goto(`${current.url}/#/hobs/${pip.id}/new`);
  await send(page, "fake:limit please");

  await expect(
    page.getByText(/Pip used up the Claude allowance for now\. It refills at .+, in 1 hour\./),
  ).toBeVisible();
  expect((await replies(current, page)).map((r) => r.status)).toEqual(["limited"]);
  await page.getByRole("button", { name: "Continue from here" }).click();
  await expect.poll(async () => (await replies(current, page)).map((r) => r.status)).toEqual(["complete"]);
});

// covers AG-005
test("[TC-CH-093] a brain that cannot think says so in the chat, and Fix it opens the provider settings", async ({
  page,
}) => {
  const { current, pip } = await hubWithPip({ HOBBOTS_FAKE_AVAILABILITY: "signedOut" });
  await page.goto(`${current.url}/#/hobs/${pip.id}/new`);

  const banner = page.getByRole("region", { name: "Brain unavailable" });
  await expect(banner).toHaveText(/Pip can't think right now: Claude Code is signed out\./);
  await banner.getByRole("link", { name: "Fix it in Settings" }).click();
  await expect(page).toHaveURL(/#\/settings#ai-providers$/);
  await expect(page.getByRole("region", { name: "AI providers" })).toBeInViewport();
});

// covers CH-004
test("[TC-CH-094] while the hub is out of reach a message waits, then goes out when it is back", async ({ page }) => {
  const { current, pip } = await hubWithPip();
  await page.goto(`${current.url}/#/hobs/${pip.id}/new`);
  await send(page, "first");
  await expect(page.getByText("Echo: first")).toBeVisible();

  await current.stop();
  await expect(page.getByRole("status").filter({ hasText: "Reconnecting to Hobbots" })).toBeVisible();
  await send(page, "while away");
  const waiting = page.getByRole("region", { name: "Waiting to send" });
  await expect(waiting).toContainText("◷ Waiting to send. It goes out when we reconnect.");

  await expect(page.getByRole("button", { name: "Try now" })).toBeVisible();
  hub = await startHub(dataDir);
  // The browser retries on its own; Try now only makes it sooner.
  await expect(page.getByText("Echo: while away")).toBeVisible();
  await expect(waiting).toBeHidden();
  await expect(page.getByText(/Reconnecting to Hobbots/)).toBeHidden();
});

// covers CH-001
test("[TC-CH-095] a new hob with no threads says hello", async ({ page }) => {
  const { current, pip } = await hubWithPip();
  await page.goto(`${current.url}/#/hobs/${pip.id}/new`);
  await expect(page.getByText("Hello, I'm Pip!")).toBeVisible();
  await expect(page.getByText("Tell me my first chore.", { exact: false })).toBeVisible();
});
