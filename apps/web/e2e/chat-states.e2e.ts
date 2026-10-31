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

const replies = async (current: Hub, page: Page, role = "assistant") => {
  const thread = page.url().match(/threads\/([^/?#]+)/)?.[1];
  const messages = await api<ReadonlyArray<Reply>>(current, "GET", `/api/threads/${thread}/messages`);
  return messages.filter((m) => m.role === role);
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
  await expect(page.getByText("Echo: first", { exact: true })).toBeVisible();

  await current.stop();
  await expect(page.getByRole("status").filter({ hasText: "Reconnecting to Hobbots" })).toBeVisible();
  await send(page, "while away");
  const waiting = page.getByRole("region", { name: "Waiting to send" });
  await expect(waiting).toContainText("◷ Waiting to send. It goes out when we reconnect.");

  await expect(page.getByRole("button", { name: "Try now" })).toBeVisible();
  hub = await startHub(dataDir);
  // The browser retries on its own; Try now only makes it sooner.
  await expect(page.getByText("Echo: while away", { exact: true })).toBeVisible();
  await expect(waiting).toBeHidden();
  await expect(page.getByText(/Reconnecting to Hobbots/)).toBeHidden();
});

// covers CH-004
test("[TC-CH-102] messages sent while the hub is away all go out, in the order they were sent", async ({ page }) => {
  const { current, pip } = await hubWithPip();
  await page.goto(`${current.url}/#/hobs/${pip.id}/new`);
  await expect(page.getByText("Hello, I'm Pip!")).toBeVisible();

  await current.stop();
  await expect(page.getByRole("status").filter({ hasText: "Reconnecting to Hobbots" })).toBeVisible();
  await send(page, "one");
  await send(page, "two");
  await send(page, "three");
  const waiting = page.getByRole("region", { name: "Waiting to send" });
  await expect(waiting).toHaveCount(3);
  await expect(waiting.nth(0)).toContainText("one");
  await expect(waiting.nth(2)).toContainText("three");

  hub = await startHub(dataDir);
  // The first starts the thread; the rest follow it there.
  await expect(page.getByText("Echo: three", { exact: true })).toBeVisible();
  await expect(waiting).toHaveCount(0);
  expect((await replies(hub, page, "user")).map((m) => m.content)).toEqual(["one", "two", "three"]);
});

// covers CH-004
test("[TC-CH-103] a waiting message the hub refuses stays until it is sent again or edited", async ({ page }) => {
  const { current, pip } = await hubWithPip();
  await page.goto(`${current.url}/#/hobs/${pip.id}/new`);
  await send(page, "first");
  await expect(page.getByText("Echo: first", { exact: true })).toBeVisible();

  await current.stop();
  await expect(page.getByRole("status").filter({ hasText: "Reconnecting to Hobbots" })).toBeVisible();
  await send(page, "keep me");
  await send(page, "after");
  // The hub comes back but refuses the first resend.
  let refuse = true;
  await page.route("**/api/threads/*/messages", (route) =>
    refuse && route.request().method() === "POST"
      ? route.fulfill({ status: 503, contentType: "application/json", body: "{}" })
      : route.fallback(),
  );
  hub = await startHub(dataDir);
  const waiting = page.getByRole("region", { name: "Waiting to send" });
  await expect(waiting.nth(0)).toContainText("◷ Not sent yet. It stays here until you try again or edit it.");
  await expect(waiting).toHaveCount(2);
  await expect(page.getByText(/Reconnecting to Hobbots/)).toBeHidden();

  refuse = false;
  await waiting.nth(0).getByRole("button", { name: "Try again" }).click();
  await expect(page.getByText("Echo: after", { exact: true })).toBeVisible();
  await expect(waiting).toHaveCount(0);
  const user = (await replies(hub, page, "user")).map((m) => m.content);
  expect(user).toEqual(["first", "keep me", "after"]);
});

// covers CH-004
test("[TC-CH-104] a refused waiting message can be edited back into the composer", async ({ page }) => {
  const { current, pip } = await hubWithPip();
  await page.goto(`${current.url}/#/hobs/${pip.id}/new`);
  await send(page, "first");
  await expect(page.getByText("Echo: first", { exact: true })).toBeVisible();

  await current.stop();
  await expect(page.getByRole("status").filter({ hasText: "Reconnecting to Hobbots" })).toBeVisible();
  await send(page, "fix me");
  await page.route("**/api/threads/*/messages", (route) =>
    route.request().method() === "POST"
      ? route.fulfill({ status: 503, contentType: "application/json", body: "{}" })
      : route.fallback(),
  );
  hub = await startHub(dataDir);
  const waiting = page.getByRole("region", { name: "Waiting to send" });
  await expect(waiting).toContainText("◷ Not sent yet.");
  await waiting.getByRole("button", { name: "Edit" }).click();
  await expect(waiting).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: /^Message Pip/ })).toHaveValue("fix me");
});

/** Holds the matching requests until `release` is called, to act while they are on their way. */
const holdRequests = async (page: Page, url: string, method: string) => {
  let release = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const held: Array<string> = [];
  await page.route(url, async (route) => {
    if (route.request().method() !== method) return route.fallback();
    held.push(route.request().url());
    await released;
    await route.fallback();
  });
  return { held, release };
};

/** Stops the hub and waits for the page to notice. */
const goOffline = async (current: Hub, page: Page) => {
  await current.stop();
  await expect(page.getByRole("status").filter({ hasText: "Reconnecting to Hobbots" })).toBeVisible();
};

// covers CH-004
test("[TC-CH-106] a message edited while the one before it starts the thread stays edited", async ({ page }) => {
  const { current, pip } = await hubWithPip();
  await page.goto(`${current.url}/#/hobs/${pip.id}/new`);
  await expect(page.getByText("Hello, I'm Pip!")).toBeVisible();

  await goOffline(current, page);
  await send(page, "first");
  await send(page, "second");
  const creating = await holdRequests(page, "**/api/agents/*/threads", "POST");
  hub = await startHub(dataDir);
  await expect.poll(() => creating.held.length).toBe(1);

  const waiting = page.getByRole("region", { name: "Waiting to send" });
  await expect(waiting.nth(0).getByRole("button", { name: "Edit" })).toBeDisabled();
  await waiting.nth(1).getByRole("button", { name: "Edit" }).click();
  const composer = page.getByRole("textbox", { name: /^Message Pip/ });
  await composer.fill("second, edited");
  creating.release();

  await expect(page).toHaveURL(/threads\//);
  await expect(page.getByText("Echo: first", { exact: true })).toBeVisible();
  await expect(composer).toHaveValue("second, edited");
  await expect(waiting).toHaveCount(0);
  expect((await replies(hub, page, "user")).map((m) => m.content)).toEqual(["first"]);
});

// covers CH-004
test("[TC-CH-107] waiting messages survive a full resync and still go out", async ({ page }) => {
  // Keeps a handle on the page's event stream, to hand it an event it cannot read.
  await page.addInitScript(() => {
    const Native = window.EventSource;
    window.EventSource = class extends Native {
      constructor(url: string | URL, init?: EventSourceInit) {
        super(url, init);
        (window as unknown as { stream: EventSource }).stream = this;
      }
    };
  });
  const { current, pip } = await hubWithPip();
  await page.goto(`${current.url}/#/hobs/${pip.id}/new`);
  await send(page, "first");
  await expect(page.getByText("Echo: first", { exact: true })).toBeVisible();

  await goOffline(current, page);
  await send(page, "after the resync");
  // The hub refuses the message, so it is still waiting when the client starts over.
  let refuse = true;
  await page.route("**/api/threads/*/messages", (route) =>
    refuse && route.request().method() === "POST"
      ? route.fulfill({ status: 503, contentType: "application/json", body: "{}" })
      : route.fallback(),
  );
  hub = await startHub(dataDir);
  const waiting = page.getByRole("region", { name: "Waiting to send" });
  await expect(waiting).toContainText("◷ Not sent yet.");

  // An event this client cannot read makes it fetch everything again from the hub.
  const refetched = page.waitForRequest((request) => request.method() === "GET" && /\/api\/agents/.test(request.url()));
  await page.evaluate(() => {
    const stream = (window as unknown as { stream: EventSource }).stream;
    stream.dispatchEvent(new MessageEvent("message", { data: "not an event" }));
  });
  await refetched;
  await page.waitForTimeout(300);
  await expect(waiting).toContainText("after the resync");
  await expect(page.getByText(/Reconnecting to Hobbots/)).toBeHidden();

  refuse = false;
  await waiting.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByText("Echo: after the resync", { exact: true })).toBeVisible();
  await expect(waiting).toHaveCount(0);
});

// covers CH-004
test("[TC-CH-108] leaving a thread while its waiting message is on its way sends it only once", async ({ page }) => {
  const { current, pip } = await hubWithPip();
  await page.goto(`${current.url}/#/hobs/${pip.id}/new`);
  await send(page, "first");
  await expect(page.getByText("Echo: first", { exact: true })).toBeVisible();
  const threadUrl = page.url();

  await goOffline(current, page);
  await send(page, "only once");
  const sending = await holdRequests(page, "**/api/threads/*/messages", "POST");
  hub = await startHub(dataDir);
  await expect.poll(() => sending.held.length).toBe(1);

  // Moving to another page in the app closes this chat while the message is still on its way.
  const threadHash = new URL(threadUrl).hash;
  await page.evaluate((hash) => {
    window.location.hash = hash;
  }, `#/hobs/${pip.id}/new`);
  await expect(page.getByText("Echo: first")).toBeHidden();
  sending.release();
  const threadId = threadHash.match(/threads\/([^/?#]+)/)?.[1];
  const userMessages = async () =>
    (await api<ReadonlyArray<Reply>>(hub as Hub, "GET", `/api/threads/${threadId}/messages`))
      .filter((m) => m.role === "user")
      .map((m) => m.content);
  await expect.poll(userMessages).toEqual(["first", "only once"]);

  await page.evaluate((hash) => {
    window.location.hash = hash;
  }, threadHash);
  await expect(page.getByText("Echo: only once", { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Waiting to send" })).toHaveCount(0);
  await page.waitForTimeout(500);
  expect(await userMessages()).toEqual(["first", "only once"]);
});

// covers CH-001
test("[TC-CH-095] a new hob with no threads says hello", async ({ page }) => {
  const { current, pip } = await hubWithPip();
  await page.goto(`${current.url}/#/hobs/${pip.id}/new`);
  await expect(page.getByText("Hello, I'm Pip!")).toBeVisible();
  await expect(page.getByText("Tell me my first chore.", { exact: false })).toBeVisible();
});
