import type { Page } from "@playwright/test";
import { admit, emptyDataDir, expect, type Hub, removeDataDir, signedOutClaudeCode, startHub, test } from "./hub.ts";

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

/** Home is the root route; hash history leaves the hash off when the app opens there. */
const atHome = /:\d+\/(#\/)?$/;

/** Opens the app as a new window does: at its root, which picks Welcome or Home. */
const openApp = async (page: Page, current: Hub) => {
  await page.goto(current.url);
};

// covers OP-001, AG-001
test("[TC-OP-015] a new installation goes from Welcome to Home and opens on Home after a restart", async ({
  page,
  browser,
}) => {
  hub = await startHub(dataDir);
  await openApp(page, hub);

  await expect(page).toHaveURL(/#\/welcome$/);
  await page.getByRole("link", { name: "Get started" }).click();

  await expect(page.getByRole("heading", { name: "Where should Hobbots run?" })).toBeVisible();
  await page.getByRole("link", { name: /Run Hobbots on this computer/ }).click();

  await expect(page.getByRole("heading", { name: "Which AI do you already use?" })).toBeVisible();
  await page.getByRole("button", { name: "Connect Claude" }).click();
  await expect(page.getByText("✓ Connected")).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();

  await expect(page.getByRole("heading", { name: "Meet your first hob" })).toBeVisible();
  await page.getByRole("textbox", { name: "Name", exact: true }).fill("Pip");
  await page.getByRole("button", { name: "Continue" }).click();

  await expect(page.getByRole("heading", { name: "How much should Pip ask first?" })).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();

  await expect(page.getByRole("heading", { name: "Where can hobs work?" })).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();

  await expect(page.getByRole("heading", { name: "Ready to summon" })).toBeVisible();
  await page.getByRole("button", { name: "Summon Pip" }).click();
  await expect(page.getByRole("heading", { name: "Pip has arrived!" })).toBeVisible();
  await page.getByRole("link", { name: "Go to Home" }).click();

  await expect(page).toHaveURL(atHome);
  await expect(page.getByRole("link", { name: /^Open chat with Pip/ })).toBeVisible();

  // The hub keeps setup and the hob, so a restarted app in a new window lands on Home.
  await hub.stop();
  hub = await startHub(dataDir);
  // A new browser context has no stored draft or last route, only what the hub knows.
  const restarted = await browser.newPage();
  await admit(restarted.context(), hub);
  await openApp(restarted, hub);
  await expect(restarted).toHaveURL(atHome);
  await expect(restarted.getByRole("link", { name: /^Open chat with Pip/ })).toBeVisible();
  await restarted.goto(`${hub.url}/#/welcome`);
  await expect(restarted).toHaveURL(atHome);
  await restarted.close();
});

/** Walks a new installation to the providers step. */
const openProviders = async (page: Page, current: Hub) => {
  await openApp(page, current);
  await page.getByRole("link", { name: "Get started" }).click();
  await page.getByRole("link", { name: /Run Hobbots on this computer/ }).click();
  await expect(page.getByRole("heading", { name: "Which AI do you already use?" })).toBeVisible();
};

/** Setup stays on the providers step: Continue is marked unavailable and only asks for a provider. */
const expectBlocked = async (page: Page) => {
  await expect(page.getByRole("button", { name: "Connect Claude" })).toHaveCount(0);
  const next = page.getByRole("button", { name: "Continue" });
  await expect(next).toHaveAttribute("aria-disabled", "true");
  // aria-disabled leaves the button clickable, so a user can still press it and read why.
  await next.click({ force: true });
  await expect(page.getByText("Connect one provider first", { exact: false })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Which AI do you already use?" })).toBeVisible();
};

// covers AG-005, OP-001
test("[TC-AG-009] a missing Claude Code blocks onboarding and shows how to install it", async ({ page }) => {
  hub = await startHub(dataDir, {
    HOBBOTS_RUNTIME: "claude",
    HOBBOTS_CLAUDE_EXECUTABLE: `${dataDir}/bin/claude`,
  });
  await openProviders(page, hub);

  const claude = page.getByRole("region", { name: "Claude" });
  await expect(claude.getByText("Not found")).toBeVisible();
  await expect(claude.getByText(/Claude Code is not on this Mac yet/)).toBeVisible();
  await expect(claude.getByRole("link", { name: "Install guide" })).toHaveAttribute(
    "href",
    "https://code.claude.com/docs/en/setup",
  );
  await expect(claude.getByRole("button", { name: "Check again" })).toBeVisible();
  await expectBlocked(page);
});

// covers AG-005, OP-001
test("[TC-AG-010] a signed-out Claude Code blocks onboarding and shows how to sign in", async ({ page }) => {
  hub = await startHub(dataDir, {
    HOBBOTS_RUNTIME: "claude",
    HOBBOTS_CLAUDE_EXECUTABLE: signedOutClaudeCode(dataDir),
  });
  await openProviders(page, hub);

  const claude = page.getByRole("region", { name: "Claude" });
  await expect(claude.getByText("Signed out")).toBeVisible();
  await expect(claude.getByText(/installed but not signed in/)).toBeVisible();
  await expect(claude.getByRole("button", { name: "Check again" })).toBeVisible();
  await expectBlocked(page);
});
