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

/** A hub with setup done and Pip, the hob these tests talk to. */
const hubWithPip = async () => {
  const current = await startHub(dataDir);
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

/** The row of the thread's reply; the fake runtime echoes the prompt into it. */
const replyRow = async (current: Hub, page: Page) => {
  await expect(page).toHaveURL(/threads\//);
  const thread = page.url().match(/threads\/([^/?#]+)/)?.[1];
  const messages = await api<ReadonlyArray<{ id: string; role: string }>>(
    current,
    "GET",
    `/api/threads/${thread}/messages`,
  );
  const reply = messages.find((message) => message.role === "assistant");
  if (reply === undefined) throw new Error("The thread has no reply yet");
  return page.locator(`#message-${reply.id}`);
};

// The fake runtime writes one word every 40 ms, so the words after the Markdown keep it streaming.
const TAIL = Array.from({ length: 50 }, (_, i) => `word${i}`).join(" ");
const FORMATTED = [
  "Here is the plan.",
  "",
  "# Launch plan",
  "",
  "- Write the page",
  "- [x] Check the copy",
  "",
  "| Hob | Task |",
  "| --- | --- |",
  "| Pip | Writing |",
  "",
  "```ts",
  'const greeting = "hello";',
  "```",
  "",
  `Some ~~old~~ new \`inline\` words. ${TAIL}`,
].join("\n");

const expectFormatted = async (reply: ReturnType<Page["locator"]>) => {
  await expect(reply.getByRole("heading", { name: "Launch plan" })).toBeVisible();
  await expect(reply.getByRole("listitem").filter({ hasText: "Write the page" })).toBeVisible();
  await expect(reply.getByRole("checkbox")).toBeChecked();
  await expect(reply.getByRole("table")).toBeVisible();
  await expect(reply.getByRole("cell", { name: "Writing" })).toBeVisible();
  const code = reply.getByRole("figure", { name: "ts code" });
  await expect(code).toContainText('const greeting = "hello";');
  await expect(reply.locator("del")).toHaveText("old");
  await expect(reply.locator(":not(pre) > code")).toHaveText("inline");
  // Markdown syntax never shows as text.
  await expect(reply).not.toContainText("| --- |");
  await expect(reply).not.toContainText("```");
  await expect(reply).not.toContainText("# Launch");
};

/**
 * Watches the reply while it streams: whether raw Markdown ever showed, and whether the table and
 * code were already formatted while the reply was still being written.
 */
const watchStream = async (reply: ReturnType<Page["locator"]>) => {
  const raw = new Set<string>();
  let formattedWhileWriting = false;
  for (let i = 0; i < 400; i++) {
    const snapshot = await reply.evaluate((row) => ({
      text: row.querySelector(".hb-markdown")?.textContent ?? "",
      writing: row.querySelector(".hb-caret") !== null,
      formatted: row.querySelector("table") !== null && row.querySelector("figure pre") !== null,
    }));
    for (const marker of ["| ---", "| Hob", "```", "~~", "# Launch"]) {
      if (snapshot.text.includes(marker)) raw.add(marker);
    }
    if (snapshot.writing && snapshot.formatted) formattedWhileWriting = true;
    if (!snapshot.writing && snapshot.text.includes("word49")) break;
    await reply.page().waitForTimeout(25);
  }
  return { raw: [...raw], formattedWhileWriting };
};

// covers CH-004
test("[TC-CH-130] a reply's headings, lists, tables and code show formatted while it streams and after a reload", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const { current, pip } = await hubWithPip();
  await page.goto(`${current.url}/#/hobs/${pip.id}/new`);
  await send(page, FORMATTED);

  const reply = await replyRow(current, page);
  // Raw Markdown never flashes, and the table and code arrive formatted while the words after them stream in.
  expect(await watchStream(reply)).toEqual({ raw: [], formattedWhileWriting: true });
  await expectFormatted(reply);
  // Your own message stays exactly as typed.
  await expect(page.getByText("| --- | --- |", { exact: false }).first()).toBeVisible();

  await page.reload();
  await expectFormatted(await replyRow(current, page));

  const code = (await replyRow(current, page)).getByRole("figure", { name: "ts code" });
  await code.getByRole("button", { name: "Copy" }).click();
  await expect(code.getByRole("button", { name: "Copied" })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('const greeting = "hello";');
});

// covers CH-004
test("[TC-CH-181] HTML in a reply shows as text and never runs", async ({ page }) => {
  const { current, pip } = await hubWithPip();
  await page.goto(`${current.url}/#/hobs/${pip.id}/new`);
  await send(
    page,
    'Look: <b>bold</b>\n\n<script>window.hobbotsRan = true</script>\n\n<img src="x" onerror="window.hobbotsRan = true">',
  );

  const reply = await replyRow(current, page);
  await expect(reply).toContainText("<script>window.hobbotsRan = true</script>");
  await expect(reply).toContainText("<b>bold</b>");
  await expect(reply).toContainText('<img src="x"');
  // Your own message shows the same HTML as typed.
  await expect(page.getByText("<script>window.hobbotsRan = true</script>").first()).toBeVisible();
  await expect(reply.locator("script, img")).toHaveCount(0);
  await expect(reply.locator("b", { hasText: "bold" })).toHaveCount(0);
  expect(await page.evaluate(() => (window as { hobbotsRan?: boolean }).hobbotsRan)).toBeUndefined();
});

// covers CH-004
test("[TC-CH-182] a reply's links show where they go and its images load only when asked", async ({ page }) => {
  const { current, pip } = await hubWithPip();
  await page.goto(`${current.url}/#/hobs/${pip.id}/new`);
  await send(
    page,
    [
      "Read [the guide](https://example.com/guide) first.",
      "",
      "Not [a trap](javascript:alert(1)) at all.",
      "",
      "![the logo](https://example.com/logo.png)",
      "",
      "[![build](https://example.com/badge.svg)](https://example.com/ci)",
    ].join("\n"),
  );

  const reply = await replyRow(current, page);
  const link = reply.getByRole("link", { name: /the guide/ });
  await expect(link).toHaveAttribute("href", "https://example.com/guide");
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toContainText("(example.com/guide)");
  await expect(reply.getByRole("link", { name: /a trap/ })).toHaveCount(0);
  await expect(reply).toContainText("Not a trap at all.");

  await expect(reply.locator("img")).toHaveCount(0);
  await reply.getByRole("button", { name: "Show image “the logo” from example.com" }).click();
  await expect(reply.getByRole("img", { name: "the logo" })).toHaveAttribute("src", "https://example.com/logo.png");

  // A badge in a link keeps its Show image button outside the link, which still shows its address.
  await expect(reply.getByRole("link").getByRole("button")).toHaveCount(0);
  await expect(reply.getByRole("link", { name: "(example.com/ci)" })).toHaveAttribute("href", "https://example.com/ci");
  await expect(reply.getByRole("button", { name: "Show image “build” from example.com" })).toBeVisible();
});
