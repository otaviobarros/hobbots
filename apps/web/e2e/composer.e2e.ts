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
  await page.goto(`${hub.url}/#/hobs/${moss.id}/chat`);
  return {
    hobUrl: `${hub.url}/#/hobs/${moss.id}`,
    hobId: moss.id,
    composer: page.getByRole("textbox", { name: /^Message Moss/ }),
  };
};

const sentTexts = async (page: Page) => {
  const channel = page.url().match(/channels\/([^/?#]+)/)?.[1];
  const messages = await call<ReadonlyArray<{ role: string; content: string }>>(`/api/channels/${channel}/messages`);
  return messages.filter((m) => m.role === "user").map((m) => m.content);
};

// The fake runtime writes one word every 40 ms, so this reply runs for a few seconds.
const LONG = `Please ${Array.from({ length: 80 }, (_, i) => `word${i}`).join(" ")}`;

const PASTED = "Steps:\n\tfirst, indented with a tab\n    second, indented with spaces\n\nThe end";

test("the composer sends plain text exactly as typed or pasted and keeps focus", async ({ page, context }) => {
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
  await expect(page).toHaveURL(/channels\//);
  await expect(composer).toHaveValue("");
  await expect(composer).toBeFocused();
  // The hub has the message exactly as typed, line breaks, tabs and indentation included.
  await expect.poll(() => sentTexts(page)).toEqual([`${PASTED}\nThanks`]);
  await expect(page.getByRole("main").getByText(/^Echo: Steps:/)).toBeVisible();

  // Focus comes back to the composer when a reply ends, so the next message can follow at once.
  await composer.fill(LONG);
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeVisible();
  await composer.blur();
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeHidden({ timeout: 15_000 });
  await expect(composer).toBeFocused();

  // Up on an empty composer brings back the last message to edit; Alt+Up is channel navigation.
  await page.keyboard.press("Alt+ArrowUp");
  await expect(composer).toHaveValue("");
  await page.keyboard.press("ArrowUp");
  await expect(composer).toHaveValue(LONG);
});
