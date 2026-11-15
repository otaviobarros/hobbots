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

const api = async <A>(current: Hub, method: string, path: string, body?: unknown): Promise<A> => {
  const response = await fetch(`${current.url}${path}`, {
    method,
    headers: { ...current.headers, ...(body !== undefined && { "content-type": "application/json" }) },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${method} ${path} answered ${response.status}: ${await response.text()}`);
  return (await response.json()) as A;
};

/** A hub past onboarding with one hob, Pip. */
const hubWithPip = async (): Promise<{ current: Hub; pipId: string }> => {
  const current = await startHub(dataDir);
  await api(current, "PATCH", "/api/setup", { completed: true, connectedProviders: ["claude-code"] });
  const pip = await api<{ readonly id: string }>(current, "POST", "/api/agents", {
    name: "Pip",
    role: "writer",
    roleTitle: "Writer",
    sigil: "writer",
    hat: null,
    tool: null,
    lookSeed: 4821,
    lookColor: "violet",
    runtime: "claude-code",
    model: null,
    effort: null,
    instructions: "",
  });
  return { current, pipId: pip.id };
};

// The fake hob echoes word by word, so a long prompt keeps its reply running for seconds.
const LONG = `Please ${Array.from({ length: 300 }, (_, i) => `word${i}`).join(" ")}`;

const composer = (page: Page) => page.getByRole("textbox", { name: /^Message Pip/ });
const type = async (page: Page, content: string) => {
  await composer(page).fill(content);
  // The composer ignores Enter while the message before is still on its way to the hub, so the
  // test waits for Send to be ready, as a person would see it, before pressing it.
  await expect(page.getByRole("button", { name: /^Send( after this reply)?$/ })).toBeEnabled();
  await composer(page).press("Enter");
  await expect(composer(page)).toHaveValue("");
};
const queued = (page: Page, content: string) =>
  page.getByRole("region", { name: "Queued message" }).filter({ hasText: content });
// Retries until the finished replies read exactly as expected, in page order.
const expectReplies = (page: Page, expected: ReadonlyArray<string>) =>
  expect(page.getByRole("main").getByText(/^Echo: (two|three|urgent|later)$/)).toHaveText([...expected], {
    timeout: 15_000,
  });

test("messages sent during a reply queue and run in order, also after a restart", async ({ page }) => {
  const { current, pipId } = await hubWithPip();
  hub = current;
  await page.goto(`${current.url}/#/hobs/${pipId}/chat`);

  await type(page, LONG);
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeVisible();
  await type(page, "two");
  await type(page, "three");
  await expect(queued(page, "two")).toContainText("Waits its turn");
  await expect(queued(page, "three")).toBeVisible();

  // The hub stops mid-reply; the queue is on disk and starts again with the hub.
  await current.stop();
  hub = await startHub(dataDir);
  await page.reload();
  await expect(page.getByRole("main").getByText("Echo: three", { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("region", { name: "Queued message" })).toHaveCount(0);
  await expectReplies(page, ["Echo: two", "Echo: three"]);
});
