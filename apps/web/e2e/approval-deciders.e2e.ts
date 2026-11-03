import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import type { Page } from "@playwright/test";
import { emptyDataDir, expect, type Hub, removeDataDir, startHub, test } from "./hub.ts";

// History names who decided each request: the approved device and where, the chat or the Inbox (#598).
let hub: Hub | undefined;
let dataDir = "";
let shared = "";

test.beforeEach(() => {
  dataDir = emptyDataDir();
  shared = realpathSync(mkdtempSync(`${dataDir}-shared-`));
});

test.afterEach(async () => {
  await hub?.stop();
  hub = undefined;
  removeDataDir(dataDir);
  rmSync(shared, { recursive: true, force: true });
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

/** Sends a message in Pip's new chat that asks to push, and waits for its card. */
const askToPush = async (page: Page, current: Hub, pipId: string) => {
  await page.goto(`${current.url}/#/hobs/${pipId}/new`);
  const composer = page.getByRole("textbox", { name: /^Message Pip/ });
  await composer.fill("Ship it\nfake:tool Bash git push origin feature");
  await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
  const card = page.getByRole("region", { name: "Pip asks permission" });
  await expect(card.getByRole("button", { name: "Allow once" })).toBeVisible();
  return card;
};

test("[TC-IN-209] History shows who decided each request: Allowed once from the device in the Inbox, Denied from it in the chat", async ({
  page,
}) => {
  const current = await startHub(dataDir);
  hub = current;
  await api(current, "PATCH", "/api/setup", {
    completed: true,
    connectedProviders: ["claude-code"],
    safetyPreset: "balanced",
    approvedFolders: [shared],
  });
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

  // Denied on its card in the chat.
  const inChat = await askToPush(page, current, pip.id);
  await inChat.getByRole("button", { name: "Deny" }).click();
  await expect(inChat.getByRole("textbox", { name: "Tell Pip why (optional)" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(inChat).toHaveAttribute("data-state", "denied");

  // Allowed once in the Inbox.
  await askToPush(page, current, pip.id);
  await page
    .getByRole("navigation", { name: "Sections" })
    .getByRole("link", { name: /^Inbox/ })
    .click();
  const detail = page.getByRole("article", { name: "Request from Pip: Push your work" });
  const inInbox = detail.getByRole("region", { name: "Pip asks permission" });
  await inInbox.getByRole("button", { name: "Allow once" }).click();
  await expect(inInbox).toHaveAttribute("data-state", "approved");

  // The page is the browser device the test fixture paired as "Playwright", not the hub's window.
  await page.getByRole("tab", { name: "History" }).click();
  const history = page.getByRole("region", { name: "Decision history" });
  await expect(history.locator('[data-state="approved"]').getByTestId("decider")).toHaveText(
    "Allowed once from Playwright in the Inbox",
  );
  await expect(history.locator('[data-state="denied"]').getByTestId("decider")).toHaveText(
    "Denied from Playwright in the chat",
  );
});
