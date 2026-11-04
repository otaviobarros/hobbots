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

  await expect(page.getByRole("heading", { name: "Where should your hobs live?" })).toBeVisible();
  await page.getByRole("link", { name: /Run Hobbots on this computer/ }).click();

  await expect(page.getByRole("heading", { name: "Which AI should your hobs think with?" })).toBeVisible();
  await page.getByRole("button", { name: "Connect Claude" }).click();
  await expect(page.getByText("✓ Connected")).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();

  await expect(page.getByRole("heading", { name: "Who should help you first?" })).toBeVisible();
  await page.getByRole("textbox", { name: "Name", exact: true }).fill("Pip");
  await page.getByRole("button", { name: "Continue" }).click();

  await expect(page.getByRole("heading", { name: "How careful should your hobs be?" })).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();

  await expect(page.getByRole("heading", { name: "Where can hobs work?" })).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();

  // Other devices comes after Folders, and can be skipped.
  await expect(page.getByRole("heading", { name: "Use Hobbots on your phone too?" })).toBeVisible();
  await page.getByRole("button", { name: "Skip for now" }).click();

  await expect(page.getByRole("heading", { name: "Everything is ready" })).toBeVisible();
  await page.getByRole("button", { name: "Light the circle" }).click();
  await expect(page.getByRole("heading", { name: "Pip is here!" })).toBeVisible();
  await page.getByRole("link", { name: "Go to Home" }).click();

  await expect(page).toHaveURL(atHome);
  await expect(
    page.getByRole("region", { name: "Your hobs right now" }).getByRole("button", { name: /^Pip, / }),
  ).toBeVisible();

  // The hub keeps setup and the hob, so a restarted app in a new window lands on Home.
  await hub.stop();
  hub = await startHub(dataDir);
  // A new browser context has no stored draft or last route, only what the hub knows.
  const restarted = await browser.newPage();
  await admit(restarted.context(), hub);
  await openApp(restarted, hub);
  await expect(restarted).toHaveURL(atHome);
  await expect(
    restarted.getByRole("region", { name: "Your hobs right now" }).getByRole("button", { name: /^Pip, / }),
  ).toBeVisible();
  await restarted.goto(`${hub.url}/#/welcome`);
  await expect(restarted).toHaveURL(atHome);
  await restarted.close();
});

/** Walks a new installation to the providers step. */
const openProviders = async (page: Page, current: Hub) => {
  await openApp(page, current);
  await page.getByRole("link", { name: "Get started" }).click();
  await page.getByRole("link", { name: /Run Hobbots on this computer/ }).click();
  await expect(page.getByRole("heading", { name: "Which AI should your hobs think with?" })).toBeVisible();
};

/** Setup stays on the providers step: Continue is marked unavailable and only asks for a provider. */
const expectBlocked = async (page: Page) => {
  await expect(page.getByRole("button", { name: "Connect Claude" })).toHaveCount(0);
  const next = page.getByRole("button", { name: "Continue" });
  await expect(next).toHaveAttribute("aria-disabled", "true");
  // aria-disabled leaves the button clickable, so a user can still press it and read why.
  await next.click({ force: true });
  await expect(page.getByText("Connect one provider first", { exact: false })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Which AI should your hobs think with?" })).toBeVisible();
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

// covers OP-001
test("[TC-OP-076] first run shows Workshop Night whatever theme is saved, and the saved theme comes back after it", async ({
  page,
}) => {
  hub = await startHub(dataDir);
  await openApp(page, hub);
  await page.evaluate(() => localStorage.setItem("hobbots.theme", JSON.stringify("lamplight-paper")));
  await page.reload();

  const theme = () => page.evaluate(() => document.documentElement.dataset.theme);
  await expect(page).toHaveURL(/#\/welcome$/);
  expect(await theme()).toBe("workshop-night");
  await page.getByRole("link", { name: "Get started" }).click();
  await expect(page.getByRole("heading", { name: "Where should your hobs live?" })).toBeVisible();
  expect(await theme()).toBe("workshop-night");
  await page.getByRole("link", { name: /Run Hobbots on this computer/ }).click();
  await expect(page.getByRole("heading", { name: "Which AI should your hobs think with?" })).toBeVisible();
  expect(await theme()).toBe("workshop-night");

  // "I already use Hobbots" skips setup and opens Home in the theme picked on this device.
  await page.goto(`${hub.url}/#/welcome`);
  await page.getByRole("button", { name: "I already use Hobbots" }).click();
  await expect(page).toHaveURL(atHome);
  await expect.poll(theme).toBe("lamplight-paper");
});
