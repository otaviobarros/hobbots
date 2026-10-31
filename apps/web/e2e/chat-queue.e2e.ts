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
  await composer(page).press("Enter");
  // The draft clears once the hub has the message.
  await expect(composer(page)).toHaveValue("");
};
const queued = (page: Page, content: string) =>
  page.getByRole("region", { name: "Queued message" }).filter({ hasText: content });
// Retries until the finished replies read exactly as expected, in page order.
const expectReplies = (page: Page, expected: ReadonlyArray<string>) =>
  expect(page.getByText(/^Echo: (two|three|urgent|later)$/)).toHaveText([...expected], { timeout: 15_000 });

// covers CH-001, CH-008
test("[TC-CH-011] messages sent during a reply queue and run in order, also after a restart", async ({ page }) => {
  const { current, pipId } = await hubWithPip();
  hub = current;
  await page.goto(`${current.url}/#/hobs/${pipId}/new`);

  await type(page, LONG);
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeVisible();
  await type(page, "two");
  await type(page, "three");
  await expect(queued(page, "two")).toContainText("Queued. Pip reads it after this reply.");
  await expect(queued(page, "three")).toBeVisible();

  // The hub stops mid-reply; the queue is on disk and starts again with the hub.
  await current.stop();
  hub = await startHub(dataDir);
  await page.reload();
  await expect(page.getByText("Echo: three", { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("region", { name: "Queued message" })).toHaveCount(0);
  await expectReplies(page, ["Echo: two", "Echo: three"]);
});

// covers CH-007, CH-008
test("[TC-CH-012] a queued message can be removed, and Send now stops the reply and runs it next", async ({ page }) => {
  const { current, pipId } = await hubWithPip();
  hub = current;
  await page.goto(`${current.url}/#/hobs/${pipId}/new`);

  await type(page, LONG);
  await type(page, "later");
  await type(page, "urgent");
  await type(page, "three");
  await queued(page, "three").getByRole("button", { name: "Remove" }).click();
  await expect(queued(page, "three")).toHaveCount(0);

  await queued(page, "urgent").getByRole("button", { name: "Send now and interrupt" }).click();
  await expect(page.getByText(/You stopped this reply\./)).toBeVisible();
  await expect(page.getByText("Echo: later", { exact: true })).toBeVisible({ timeout: 15_000 });
  await expectReplies(page, ["Echo: urgent", "Echo: later"]);
  await expect(page.getByText("Echo: three")).toHaveCount(0);
});

// covers AG-006, CH-008
test("[TC-CH-014] messages sent to a paused hob queue and run once it wakes", async ({ page }) => {
  const { current, pipId } = await hubWithPip();
  hub = current;
  await page.goto(`${current.url}/#/hobs/${pipId}/new`);
  await type(page, "two");
  await expectReplies(page, ["Echo: two"]);

  await api(current, "POST", `/api/agents/${pipId}/pause`);
  await expect(page.getByRole("button", { name: "Wake Pip" })).toBeVisible();
  await composer(page).fill("three");
  await page.getByRole("button", { name: "Queue" }).click();
  await expect(composer(page)).toHaveValue("");
  await expect(queued(page, "three")).toContainText("Queued. Waits until you wake Pip.");
  await expect(queued(page, "three").getByRole("button", { name: /Send now/ })).toHaveCount(0);

  await page.getByRole("button", { name: "Wake Pip" }).click();
  await expectReplies(page, ["Echo: two", "Echo: three"]);
  await expect(page.getByRole("region", { name: "Queued message" })).toHaveCount(0);
});
