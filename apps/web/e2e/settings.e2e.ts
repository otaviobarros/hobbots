import { realpathSync } from "node:fs";
import type { Page } from "@playwright/test";
import {
  emptyDataDir,
  expect,
  type FakeCodexState,
  fakeCodexAt,
  type Hub,
  removeDataDir,
  signedOutClaudeCode,
  startHub,
  test,
} from "./hub.ts";

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

/** Starts a hub whose setup is finished and opens Settings on it. */
const openSettings = async (page: Page, env: Record<string, string> = {}) => {
  hub = await startHub(dataDir, env);
  const response = await fetch(`${hub.url}/api/setup`, {
    method: "PATCH",
    headers: { ...hub.headers, "content-type": "application/json" },
    body: JSON.stringify({ completed: true }),
  });
  if (!response.ok) throw new Error(`Finishing setup answered ${response.status}`);
  await page.goto(`${hub.url}/#/settings`);
  return hub;
};

/** The animation an element with a stepped motion token runs right now, or "none". */
const runningAnimation = (page: Page) =>
  page.evaluate(() => {
    const probe = document.createElement("span");
    probe.className = "animate-hb-bob";
    document.body.append(probe);
    const name = getComputedStyle(probe).animationName;
    probe.remove();
    return name;
  });

// covers UX-003, UX-005
test("[TC-UX-023] Reduce motion follows the system until changed, and stops every animation when on", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await openSettings(page);
  const section = page.getByRole("region", { name: "This app" });
  const reduce = section.getByRole("switch", { name: "Reduce motion" });

  await expect(reduce).not.toBeChecked();
  await expect(section.getByText("Follows your system setting on this device.")).toBeVisible();
  expect(await runningAnimation(page)).toBe("hb-bob");

  // On, it stops every animation, and the choice stays on this device after a reload.
  await reduce.click();
  await expect(reduce).toBeChecked();
  expect(await runningAnimation(page)).toBe("none");
  await page.reload();
  await expect(reduce).toBeChecked();
  expect(await runningAnimation(page)).toBe("none");

  // Back to the system's choice, which plays motion.
  await section.getByRole("button", { name: "Use the system setting" }).click();
  await expect(reduce).not.toBeChecked();
  expect(await runningAnimation(page)).toBe("hb-bob");

  // A system that asks for less motion turns it on, until this device says otherwise.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(reduce).toBeChecked();
  expect(await runningAnimation(page)).toBe("none");
  await reduce.click();
  await expect(reduce).not.toBeChecked();
  await expect(section.getByText("Set on this device. Your system setting is on.")).toBeVisible();
  expect(await runningAnimation(page)).toBe("hb-bob");
});

// covers AG-005, UX-005
test("[TC-UX-024] a signed-out runtime shows how to fix it in Settings › AI providers", async ({ page }) => {
  await openSettings(page, {
    HOBBOTS_RUNTIME: "claude",
    HOBBOTS_CLAUDE_EXECUTABLE: signedOutClaudeCode(dataDir),
  });
  const providers = page.getByRole("region", { name: "AI providers" }).getByRole("region", { name: "Claude Code" });

  await expect(providers.getByText("Signed out")).toBeVisible();
  await expect(providers.getByText(/installed but not signed in/)).toBeVisible();
  await expect(providers.getByRole("button", { name: "Check again" })).toBeVisible();
  await expect(providers.getByRole("heading", { name: "Enforcement on this hub" })).toBeVisible();
});

// covers AG-005, RT-001
// TC-RT-012 is retired: a signed-in Codex is ready now that its turns run (#438), checked by TC-RT-036.
test("[TC-RT-036] Settings › AI providers shows a ready, signed-in Codex, and each state that stops it with its fix", async ({
  page,
}) => {
  await openSettings(page, { HOBBOTS_RUNTIME: "claude", HOBBOTS_CLAUDE_EXECUTABLE: signedOutClaudeCode(dataDir) });
  const codex = page.getByRole("region", { name: "AI providers" }).getByRole("region", { name: "Codex" });
  const checkAgain = async (state: FakeCodexState) => {
    fakeCodexAt(dataDir, state);
    await codex.getByRole("button", { name: "Check again" }).click();
  };

  // Not installed: the install guide, and no restart needed.
  await expect(codex.getByText("Unavailable")).toBeVisible();
  await expect(codex.getByText(/Codex was not found or could not start/)).toBeVisible();
  await expect(codex.getByRole("link", { name: "Install guide" })).toBeVisible();

  await checkAgain("outdated");
  await expect(codex.getByText("Outdated")).toBeVisible();
  await expect(codex.getByText(/older than Hobbots supports/)).toBeVisible();

  await checkAgain("signedOut");
  await expect(codex.getByText("Signed out")).toBeVisible();
  await expect(codex.getByText(/installed but not signed in/)).toBeVisible();
  await expect(codex.getByText("codex login")).toBeVisible();

  await checkAgain("apiKey");
  await expect(codex.getByText(/signed in with an API key/)).toBeVisible();

  // Signed in with ChatGPT: ready, with nothing left to fix.
  await checkAgain("ready");
  await expect(codex.getByText("Ready")).toBeVisible();
  await expect(codex.getByText("subscription (plus)")).toBeVisible();
  await expect(codex.getByText("0.166.0")).toBeVisible();
  await expect(codex.getByRole("button", { name: "Check again" })).toBeHidden();
});

// covers UX-005
test("[TC-UX-025] Help and about shows the version, the hub's data folder and the licenses", async ({ page }) => {
  const current = await openSettings(page);
  const about = page.getByRole("region", { name: "Help and about" });

  await expect(about.getByText("Development build")).toBeVisible();
  await expect(about.getByText(realpathSync(current.dataDir), { exact: true })).toBeVisible();
  await expect(about.getByRole("link", { name: "Apache License 2.0" })).toHaveAttribute(
    "href",
    "https://github.com/otaviobarros/hobbots/blob/main/LICENSE",
  );
  await expect(about.getByRole("link", { name: "Open-source libraries" })).toBeVisible();

  // A browser shows where notifications are set; the desktop app has the switches.
  await expect(
    page.getByRole("region", { name: "This app" }).getByText(/Notifications come from the Hobbots app/),
  ).toBeVisible();
});
