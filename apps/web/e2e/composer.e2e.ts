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

const call = async <A>(path: string, method = "GET", body?: unknown): Promise<A> => {
  if (hub === undefined) throw new Error("No hub is running.");
  const response = await fetch(`${hub.url}${path}`, {
    method,
    headers: { ...hub.headers, ...(body !== undefined && { "content-type": "application/json" }) },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${method} ${path} answered ${response.status}`);
  return (await response.json()) as A;
};

/** Opens a fresh page with Moss, a hob on the fake runtime, ready to talk. */
const openMoss = async (page: Page) => {
  hub = await startHub(dataDir);
  await call("/api/setup", "PATCH", { completed: true, connectedProviders: ["claude-code"] });
  const moss = await call<{ id: string }>("/api/agents", "POST", {
    name: "Moss",
    role: "writer",
    roleTitle: "Writer",
    sigil: "writer",
    hat: "pointed",
    tool: "quill",
    lookSeed: 1234,
    lookColor: "violet",
    runtime: "claude-code",
    model: "fake-thinker",
    effort: "medium",
    instructions: "",
  });
  await page.goto(`${hub.url}/#/hobs/${moss.id}/new`);
  return { hobUrl: `${hub.url}/#/hobs/${moss.id}`, composer: page.getByRole("textbox", { name: /^Message Moss/ }) };
};

const sentTexts = async (page: Page) => {
  const thread = page.url().match(/threads\/([^/?#]+)/)?.[1];
  const messages = await call<ReadonlyArray<{ role: string; content: string }>>(`/api/threads/${thread}/messages`);
  return messages.filter((m) => m.role === "user").map((m) => m.content);
};

// The fake runtime writes one word every 40 ms, so this reply runs for a few seconds.
const LONG = `Please ${Array.from({ length: 80 }, (_, i) => `word${i}`).join(" ")}`;

const PASTED = "Steps:\n\tfirst, indented with a tab\n    second, indented with spaces\n\nThe end";

// covers CH-001
test("[TC-CH-131] the composer sends plain text exactly as typed or pasted and keeps focus", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const { composer } = await openMoss(page);
  await composer.click();

  // Rich text pastes as its plain text, with its line breaks, tabs and indentation.
  await page.evaluate(async (text) => {
    const html = `<p><b>Steps:</b></p><pre>${text.slice("Steps:\n".length)}</pre>`;
    await navigator.clipboard.write([
      new ClipboardItem({
        "text/plain": new Blob([text], { type: "text/plain" }),
        "text/html": new Blob([html], { type: "text/html" }),
      }),
    ]);
  }, PASTED);
  await page.keyboard.press("ControlOrMeta+V");
  await expect(composer).toHaveValue(PASTED);

  // Shift+Enter adds a line; Enter while an IME composes picks a candidate and never sends.
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("Thanks");
  await composer.dispatchEvent("keydown", { key: "Enter", isComposing: true, bubbles: true });
  await expect(composer).toHaveValue(`${PASTED}\nThanks`);

  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/threads\//);
  await expect(composer).toHaveValue("");
  await expect(composer).toBeFocused();
  // The hub has the message exactly as typed, line breaks, tabs and indentation included.
  await expect.poll(() => sentTexts(page)).toEqual([`${PASTED}\nThanks`]);
  await expect(page.getByText(/^Echo: Steps:/)).toBeVisible();

  // Focus comes back to the composer when a reply ends, so the next message can follow at once.
  await composer.fill(LONG);
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeVisible();
  await composer.blur();
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeHidden({ timeout: 15_000 });
  await expect(composer).toBeFocused();

  // Up on an empty composer brings back the last message to edit; Alt+Up is thread navigation.
  await page.keyboard.press("Alt+ArrowUp");
  await expect(composer).toHaveValue("");
  await page.keyboard.press("ArrowUp");
  await expect(composer).toHaveValue(LONG);
});

// covers CH-001
test("[TC-CH-133] a send the hub refuses puts its text back in the composer", async ({ page }) => {
  const { composer } = await openMoss(page);
  await composer.fill("Start a thread");
  await composer.press("Enter");
  await expect(page.getByText("Echo: Start a thread")).toBeVisible();

  await page.route("**/api/threads/*/messages", (route) =>
    route.request().method() === "POST" ? route.abort() : route.fallback(),
  );
  await composer.fill("Line one\n  line two");
  await composer.press("Enter");
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(composer).toHaveValue("Line one\n  line two");
});

// covers CH-001, CH-003
test("[TC-CH-132] each thread keeps its unsent draft, and a long draft grows, then scrolls", async ({ page }) => {
  const { hobUrl, composer } = await openMoss(page);
  await composer.fill("Start a thread");
  await composer.press("Enter");
  await expect(page).toHaveURL(/threads\//);
  const threadUrl = page.url();
  await expect(page.getByText("Echo: Start a thread")).toBeVisible();

  await composer.fill("Half a thought");
  await page.goto(`${hobUrl}/new`);
  await expect(composer).toHaveValue("");
  await composer.fill("A different idea");
  await page.goto(threadUrl);
  await expect(composer).toHaveValue("Half a thought");
  await page.goto(`${hobUrl}/new`);
  await expect(composer).toHaveValue("A different idea");

  // A reload keeps the draft too, even one typed a moment before.
  await page.goto(threadUrl);
  await page.reload();
  await expect(composer).toHaveValue("Half a thought");

  // A transcript taller than the window stays at its end while the composer grows.
  const tall = Array.from({ length: 40 }, (_, i) => `Row ${i + 1}`).join("\n");
  await composer.fill(tall);
  await composer.press("Enter");
  await expect(page.getByText(/^Echo: Row 1/)).toBeVisible();
  // Once the reply has finished, nothing but the composer moves the transcript.
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeHidden({ timeout: 15_000 });
  const transcript = page.getByRole("main", { name: "Chat" }).locator(".overflow-y-auto").first();
  const fromEnd = () => transcript.evaluate((view) => view.scrollHeight - view.scrollTop - view.clientHeight);
  await expect.poll(fromEnd).toBeLessThan(24);
  expect(await transcript.evaluate((view) => view.scrollHeight > view.clientHeight)).toBe(true);

  // Thousands of characters still type into a composer that stops growing and scrolls instead.
  const long = Array.from({ length: 60 }, (_, i) => `Line ${i + 1} of a long draft`).join("\n");
  await composer.fill(long);
  await page.keyboard.type(" and more");
  await expect(composer).toHaveValue(`${long} and more`);
  const box = await composer.evaluate((input) => ({ shown: input.clientHeight, full: input.scrollHeight }));
  expect(box.shown).toBeLessThanOrEqual(160);
  expect(box.full).toBeGreaterThan(box.shown);
  await expect.poll(fromEnd).toBeLessThan(24);
});
