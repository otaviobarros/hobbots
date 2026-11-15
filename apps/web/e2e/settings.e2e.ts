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

/** Starts a hub whose setup is finished and opens a section of Settings on it, or its overview. */
const openSettings = async (page: Page, section = "", env: Record<string, string> = {}) => {
  hub = await startHub(dataDir, env);
  const response = await fetch(`${hub.url}/api/setup`, {
    method: "PATCH",
    headers: { ...hub.headers, "content-type": "application/json" },
    body: JSON.stringify({ completed: true }),
  });
  if (!response.ok) throw new Error(`Finishing setup answered ${response.status}`);
  await page.goto(`${hub.url}/#/settings${section ? `/${section}` : ""}`);
  return hub;
};

// Issue #1088
test("Help's check says when it could not read memory, the first time or after an answer, never an old answer (#1088)", async ({
  page,
}) => {
  await openSettings(page, "help");
  const check = page.getByRole("region", { name: "Check that everything works" });
  const failMemory = () =>
    page.route(/\/api\/memory(\?.*)?$/, (route) =>
      route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ _tag: "Unavailable" }) }),
    );

  // The first read fails: the line says so instead of leaving memory out.
  await failMemory();
  await check.getByRole("button", { name: "Check now" }).click();
  // A failed read is tried again a few times before it counts as failed.
  await expect(check).toContainText("Hobbots could not check memory. Check again in a moment.", { timeout: 20_000 });

  // It answers once the hub does.
  await page.unroute(/\/api\/memory(\?.*)?$/);
  await check.getByRole("button", { name: "Check again" }).click();
  await expect(check).toContainText("Memory is turned off (optional)");

  // A refresh that fails says so too, and never shows the earlier answer as if it were new.
  await failMemory();
  await check.getByRole("button", { name: "Check again" }).click();
  await expect(check).toContainText("Hobbots could not check memory. Check again in a moment.", { timeout: 20_000 });
  await expect(check).not.toContainText("Memory is turned off (optional)");
});
