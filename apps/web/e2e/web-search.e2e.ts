import type { Page } from "@playwright/test";
import { expect, test } from "./hub.ts";
import { aldricHub, script, stopAldricHub } from "./workbench-hub.ts";

// Issue #1271: the web search screens (ADR 036), with the fake runtime's search and a stand-in web.

test.afterEach(stopAldricHub);

const THEMES = ["lamplight-dusk", "lamplight-paper", "workshop-night", "workshop-daylight"] as const;

/** Where screenshots of each surface go when `HOBBOTS_E2E_SHOTS` names a folder, to compare with the design. */
const shot = async (page: Page, name: string) => {
  const folder = process.env.HOBBOTS_E2E_SHOTS;
  if (folder !== undefined) await page.screenshot({ path: `${folder}/${name}.png` });
};

/** Puts the app in `theme`, as Settings › This app would. */
const pickTheme = async (page: Page, theme: string) => {
  await page.evaluate((id) => localStorage.setItem("hobbots.theme", JSON.stringify(id)), theme);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
};

/** Sends a message to Aldric and waits for his reply to end. */
const send = async (page: Page, lines: ReadonlyArray<string>) => {
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  await composer.fill(lines.join("\n"));
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeHidden({ timeout: 30_000 });
};

const fetchPage = (url: string) => script("web_fetch", { url });

// covers ADR 036 (Usage and limits), UX-006
test("[TC-UX-1271-01] a reply that searched and read pages shows its steps, its sources, and what Open shows of each", async ({
  page,
  scan,
}) => {
  const { url, aldric } = await aldricHub({}, [], { HOBBOTS_FAKE_WEB: "on" });
  await page.goto(`${url}/#/hobs/${aldric}/new`);
  await send(page, [
    "How big can a launch email be?",
    "fake:search gmail size limit",
    fetchPage("https://search.hobbots.test/gmail-size-limit"),
    fetchPage("https://search.hobbots.test/gmail-size-limit/releases"),
  ]);

  const lines = page.getByRole("list", { name: "What Aldric looked up" });
  await expect(lines.getByRole("listitem")).toHaveCount(3);
  await expect(lines.getByRole("listitem").nth(0)).toContainText("Searched: gmail size limit · 2 results");
  await expect(lines.getByRole("listitem").nth(1)).toContainText("Read: search.hobbots.test · Gmail size limit");
  const sources = page.getByRole("region", { name: "Sources" });
  await expect(sources.getByRole("button")).toHaveCount(2);
  // The done steps show only as their lines.
  await expect(page.getByRole("list", { name: "Reply steps" })).not.toContainText("Reading a web page");
  await scan();
  await shot(page, "chat-web");

  // Open on a page: what Aldric got, where it came from and its links.
  await sources.getByRole("button").first().click();
  const pageSheet = page.getByRole("dialog");
  await expect(pageSheet).toContainText("A page Aldric read");
  await expect(pageSheet.getByRole("heading", { name: "Gmail size limit", level: 2 })).toBeVisible();
  await expect(pageSheet).toContainText("https://search.hobbots.test/gmail-size-limit");
  await expect(pageSheet).toContainText("A result of the search “gmail size limit”");
  await expect(pageSheet).toContainText("This test page on search.hobbots.test is about gmail size limit.");
  await expect(pageSheet.getByRole("region", { name: "Links on the page" })).toContainText("More on gmail size limit");
  await expect(pageSheet.getByRole("link", { name: "Open in your browser" })).toHaveAttribute(
    "href",
    "https://search.hobbots.test/gmail-size-limit",
  );
  await scan(pageSheet);
  for (const theme of THEMES) {
    await pickTheme(page, theme);
    await page.getByRole("region", { name: "Sources" }).getByRole("button").first().click();
    await expect(page.getByRole("dialog")).toContainText("A page Aldric read");
    await shot(page, `chat-web-page--${theme}`);
    await page.keyboard.press("Escape");
  }

  // Open on a search: its query, who ran it, and its results with the ones read marked.
  await page.getByRole("button", { name: "Open the search gmail size limit" }).click();
  const searchSheet = page.getByRole("dialog");
  await expect(searchSheet).toContainText("A search Aldric ran");
  await expect(searchSheet).toContainText("Claude Code's search");
  await expect(searchSheet.getByRole("listitem")).toHaveCount(2);
  await expect(searchSheet.getByRole("listitem").first()).toContainText("· Read");
  await scan(searchSheet);
  await shot(page, "chat-web-search");
});

// covers ADR 036 (Asking), UX-006
test("[TC-UX-1271-02] a page on the local network and an address Aldric wrote ask with their own cards", async ({
  page,
  scan,
}) => {
  const { url, aldric } = await aldricHub({}, [], { HOBBOTS_FAKE_WEB: "on" });
  await page.goto(`${url}/#/hobs/${aldric}/new`);
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  await composer.fill(
    ["Where are the launch images kept?", fetchPage("http://nas.hobbots.test/docs/shares")].join("\n"),
  );
  await composer.press("Enter");

  const local = page.getByRole("region", { name: "Aldric asks permission" });
  await expect(local).toContainText("Aldric asks to read a page on your local network");
  await expect(local).toContainText("http://nas.hobbots.test/docs/shares");
  await expect(local).toContainText("nas.hobbots.test is on your local network");
  await expect(local.getByRole("button", { name: "Always for this host" })).toBeVisible();
  await scan(local);
  await shot(page, "chat-web-ask-local");
  await local.getByRole("button", { name: "Allow once" }).click();
  await expect(local).toHaveAttribute("data-state", "approved");
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeHidden({ timeout: 30_000 });

  // The slashes are escaped, so the address is not in the message: Aldric wrote it.
  await composer.fill(
    'Check the stats\nfake:hub web_fetch {"url":"https:\\/\\/stats.hobbots.test\\/collect?from=you"}',
  );
  await composer.press("Enter");
  const written = page.getByRole("region", { name: "Aldric asks permission" }).last();
  await expect(written).toContainText("Aldric asks to open an address it wrote itself");
  await expect(written).toContainText("https://stats.hobbots.test/collect?from=you");
  await expect(written.getByRole("button", { name: /^Always/ })).toHaveCount(0);
  await scan(written);
  await shot(page, "chat-web-ask-written");
  await written.getByRole("button", { name: "Deny" }).click();
  await written.getByRole("button", { name: "Deny" }).last().click();
  await expect(written).toHaveAttribute("data-state", "denied");
});

// covers ADR 036 (Settings and Permissions, Usage and limits), UX-006
test("[TC-UX-1271-03] Permissions, Charms, Settings › Web and Usage show the web in every theme", async ({
  page,
  scan,
}) => {
  test.setTimeout(180_000);
  const { url, aldric } = await aldricHub({}, [], { HOBBOTS_FAKE_WEB: "on" });
  await page.goto(`${url}/#/hobs/${aldric}/new`);
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  await composer.fill(
    ["Read the NAS docs", "fake:search gmail size limit", fetchPage("http://nas.hobbots.test/docs/shares")].join("\n"),
  );
  await composer.press("Enter");
  // Always for this host saves a site rule for the NAS.
  const local = page.getByRole("region", { name: "Aldric asks permission" });
  await local.getByRole("button", { name: "Always for this host" }).click();
  await local.getByRole("button", { name: "Save the rule and allow" }).click();
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeHidden({ timeout: 30_000 });

  // Permissions: the site rule and the limits, set for Aldric alone.
  await page.goto(`${url}/#/hobs/${aldric}/profile?tab=permissions`);
  const rules = page.getByRole("region", { name: "Site rules" });
  await expect(rules.getByRole("listitem")).toHaveCount(1);
  await expect(rules).toContainText("nas.hobbots.test");
  const limits = page.getByRole("region", { name: "Web limits" });
  await expect(limits).toContainText("10 searches and 30 pages a turn · 200 searches a day");
  await expect(limits).toContainText("The same as every hob, from Settings › Web.");
  await scan();
  await limits.getByRole("button", { name: "Set for Aldric" }).click();
  await limits.getByLabel("Searches in one turn").fill("4");
  await limits.getByRole("button", { name: "Save limits" }).click();
  await expect(limits).toContainText("4 searches and 30 pages a turn");
  await expect(limits).toContainText("Only Aldric.");
  for (const theme of THEMES) {
    await pickTheme(page, theme);
    await expect(page.getByRole("region", { name: "Site rules" })).toContainText("nas.hobbots.test");
    await page.getByRole("region", { name: "Web limits" }).scrollIntoViewIfNeeded();
    await shot(page, `hob-permissions-web--${theme}`);
  }
  await page.getByRole("region", { name: "Web limits" }).getByRole("button", { name: "Use Settings › Web" }).click();
  await expect(page.getByRole("region", { name: "Web limits" })).toContainText("The same as every hob");
  await page
    .getByRole("region", { name: "Site rules" })
    .getByRole("button", { name: "Remove the rule for nas.hobbots.test" })
    .click();
  await expect(page.getByRole("region", { name: "Site rules" })).toContainText("No site rules yet.");

  // Charms: the two built in tools, with Aldric's runtime named.
  await page.getByRole("tab", { name: "Charms" }).click();
  const builtIn = page.getByRole("region", { name: "Built in" });
  await expect(builtIn.getByRole("article")).toHaveCount(2);
  await expect(builtIn.getByRole("article", { name: "Web search" })).toContainText("Search the web: Allow");
  await scan(builtIn);
  for (const theme of THEMES) {
    await pickTheme(page, theme);
    await page.getByRole("tab", { name: "Charms" }).click();
    await page.getByRole("region", { name: "Built in" }).scrollIntoViewIfNeeded();
    await shot(page, `hob-charms-web--${theme}`);
  }

  // Settings › Web: a limit, a blocked site and the page cache.
  await page.goto(`${url}/#/settings/web`);
  await expect(page.getByRole("heading", { name: "Web", level: 2 })).toBeVisible();
  const pagesField = page.getByLabel("Pages read in one turn");
  await pagesField.fill("12");
  await pagesField.press("Enter");
  await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();
  await page.getByLabel("A site to block").fill("pastebin.com");
  await page.getByRole("button", { name: "Block" }).click();
  await expect(page.getByRole("list", { name: "Sites hobs never read" })).toContainText("pastebin.com");
  const cache = page.getByRole("region", { name: "Page cache" });
  await expect(cache).toContainText("1 page cached");
  await scan();
  for (const theme of THEMES) {
    await pickTheme(page, theme);
    await expect(page.getByLabel("Pages read in one turn")).toHaveValue("12");
    await shot(page, `settings-web--${theme}`);
  }
  await page.getByRole("region", { name: "Page cache" }).getByRole("button", { name: "Clear now" }).click();
  await expect(page.getByRole("region", { name: "Page cache" })).toContainText("No pages cached");

  // Usage: the period's searches and pages, by hob and by turn.
  await page.goto(`${url}/#/usage`);
  const usage = page.getByRole("region", { name: "Searches and pages" });
  await expect(usage.getByRole("row")).toHaveCount(2);
  await expect(usage.getByRole("row").nth(1)).toContainText("Aldric");
  await expect(usage).toContainText("No extra cost");
  await scan(usage);
  for (const theme of THEMES) {
    await pickTheme(page, theme);
    await page.getByRole("region", { name: "Searches and pages" }).scrollIntoViewIfNeeded();
    await shot(page, `usage-web--${theme}`);
  }
  await page.getByRole("region", { name: "Searches and pages" }).getByRole("radio", { name: "Busiest turns" }).click();
  await expect(page.getByRole("region", { name: "Searches and pages" })).toContainText("Read the NAS docs");
  await shot(page, "usage-web-turns");
});

/**
 * Fails every `method` request to `path` until the returned function is called, so a read stays
 * failed however often the app tries it again on its own.
 */
const failing = async (page: Page, method: string, path: RegExp) => {
  let on = true;
  await page.route(path, (route) =>
    on && route.request().method() === method ? route.fulfill({ status: 500, body: "" }) : route.fallback(),
  );
  return () => {
    on = false;
  };
};

// covers ADR 036 (Amendment: the screens), STD-REACT-015, STD-REACT-016, STD-UI-009
test("[TC-UX-1271-04] a web read that fails says so with Try again, and a save that fails keeps what you typed", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const { url, aldric } = await aldricHub({}, [], { HOBBOTS_FAKE_WEB: "on" });
  const settingsBack = await failing(page, "GET", /\/api\/web\/settings$/);
  const cacheBack = await failing(page, "GET", /\/api\/web\/cache$/);
  await page.goto(`${url}/#/settings/web`);
  const settingsFailed = page.getByRole("alert").filter({ hasText: "Hobbots could not read Settings › Web." });
  await expect(settingsFailed).toBeVisible({ timeout: 30_000 });
  settingsBack();
  await page.getByRole("button", { name: "Try again" }).click();
  const cache = page.getByRole("region", { name: "Page cache" });
  await expect(cache.getByRole("alert")).toHaveText("Hobbots could not read the page cache.", { timeout: 30_000 });
  cacheBack();
  await cache.getByRole("button", { name: "Try again" }).click();
  await expect(cache).toContainText("No pages cached");

  // A limit and a site whose save fails stay as typed, and save on the next try.
  const savesBack = await failing(page, "PUT", /\/api\/web\/settings$/);
  const pagesField = page.getByLabel("Pages read in one turn");
  await pagesField.fill("12");
  await pagesField.press("Enter");
  await expect(page.getByRole("alert")).toContainText("Hobbots could not save Settings › Web.");
  await expect(pagesField).toHaveValue("12");
  const site = page.getByLabel("A site to block");
  await site.fill("pastebin.com");
  await page.getByRole("button", { name: "Block" }).click();
  await expect(page.getByRole("alert")).toContainText("Your changes are still here");
  await expect(site).toHaveValue("pastebin.com");
  savesBack();
  await page.getByRole("button", { name: "Block" }).click();
  await expect(page.getByRole("list", { name: "Sites hobs never read" })).toContainText("pastebin.com");
  await expect(site).toHaveValue("");
  // Two limits changed one after the other are both saved, the second with the first.
  const searchesField = page.getByLabel("Searches in one turn");
  await searchesField.fill("5");
  // Leaving the first field saves it; the second waits for that save, then saves both.
  await pagesField.fill("14");
  const both = page.waitForResponse(
    (response) =>
      response.request().method() === "PUT" &&
      response.url().endsWith("/api/web/settings") &&
      (response.request().postData() ?? "").includes('"pagesPerTurn":14'),
  );
  await pagesField.press("Enter");
  expect((await both).ok()).toBe(true);
  await page.reload();
  await expect(page.getByLabel("Searches in one turn")).toHaveValue("5");
  await expect(page.getByLabel("Pages read in one turn")).toHaveValue("14");
  await expect(page.getByRole("list", { name: "Sites hobs never read" })).toContainText("pastebin.com");

  // Permissions: the site rules and the hob's limits each say they could not be read.
  const grantsBack = await failing(page, "GET", /\/api\/grants$/);
  const limitsBack = await failing(page, "GET", /\/api\/agents\/[^/]+\/web-limits$/);
  await page.goto(`${url}/#/hobs/${aldric}/profile?tab=permissions`);
  const rules = page.getByRole("region", { name: "Site rules" });
  await expect(rules.getByRole("alert")).toHaveText("Hobbots could not read this hob's site rules.", {
    timeout: 30_000,
  });
  grantsBack();
  await rules.getByRole("button", { name: "Try again" }).click();
  await expect(rules).toContainText("No site rules yet.");
  const limits = page.getByRole("region", { name: "Web limits" });
  await expect(limits.getByRole("alert")).toHaveText("Hobbots could not read this hob's web limits.", {
    timeout: 30_000,
  });
  limitsBack();
  await limits.getByRole("button", { name: "Try again" }).click();
  await expect(limits).toContainText("5 searches and 14 pages a turn");

  // Usage: the summary says it could not be read, and Try again reads it.
  const usageBack = await failing(page, "GET", /\/api\/web\/usage\/summary/);
  await page.goto(`${url}/#/usage`);
  const usage = page.getByRole("region", { name: "Searches and pages" });
  await expect(usage.getByRole("alert")).toHaveText("Hobbots could not read searches and pages.", {
    timeout: 30_000,
  });
  usageBack();
  await usage.getByRole("button", { name: "Try again" }).click();
  await expect(usage).toContainText("No hob searched or read a page in this time.");
});

/** Holds the next `method` request to `path` until the returned function is called, then lets it and the rest through. */
const holding = async (page: Page, method: string, path: RegExp) => {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(path, async (route) => {
    if (route.request().method() === method) await gate;
    return route.fallback();
  });
  return release;
};

// covers ADR 036 (Amendment: the screens), STD-REACT-016
test("[TC-UX-1271-05] what you type while a save runs stays when that save ends", async ({ page }) => {
  const { url } = await aldricHub({}, [], { HOBBOTS_FAKE_WEB: "on" });
  await page.goto(`${url}/#/settings/web`);
  const pagesField = page.getByLabel("Pages read in one turn");
  await pagesField.fill("12");
  await pagesField.press("Enter");
  await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();

  // A site typed while the one before it saves stays in the field.
  const siteSaved = await holding(page, "PUT", /\/api\/web\/settings$/);
  const site = page.getByLabel("A site to block");
  await site.fill("pastebin.com");
  await page.getByRole("button", { name: "Block" }).click();
  await site.fill("example.org");
  siteSaved();
  await expect(page.getByRole("list", { name: "Sites hobs never read" })).toContainText("pastebin.com");
  await expect(site).toHaveValue("example.org");
  await page.unrouteAll({ behavior: "wait" });

  // A limit typed while Reset saves stays, and the others show the defaults.
  const resetSaved = await holding(page, "PUT", /\/api\/web\/settings$/);
  await page.getByRole("button", { name: "Reset to 10, 30 and 200" }).click();
  const searchesField = page.getByLabel("Searches in one turn");
  await searchesField.fill("7");
  resetSaved();
  await expect(pagesField).toHaveValue("30");
  await expect(searchesField).toHaveValue("7");
});

// covers ADR 036 (Validation), UX-006, #1272
test("[TC-UX-1272-01] under Careful, Aldric searches, asks once for the new site, reads two results and answers with them as sources", async ({
  page,
  scan,
}) => {
  const { url, aldric, api } = await aldricHub({}, [], { HOBBOTS_FAKE_WEB: "on" });
  await api("PATCH", "/setup", { safetyPreset: "careful" });
  await page.goto(`${url}/#/hobs/${aldric}/new`);
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  await composer.fill(
    [
      "How big can a launch email be? Cite your sources.",
      "fake:search gmail size limit",
      fetchPage("https://search.hobbots.test/gmail-size-limit"),
      fetchPage("https://search.hobbots.test/gmail-size-limit/releases"),
    ].join("\n"),
  );
  await composer.press("Enter");

  // The first page on the new site asks, and Always answers for the whole site.
  const ask = page.getByRole("region", { name: "Aldric asks permission" });
  await expect(ask).toContainText("Aldric asks to read a page on a new site");
  await expect(ask).toContainText("https://search.hobbots.test/gmail-size-limit");
  await expect(ask).toContainText("The first page on each new site asks at your safety level.");
  await scan(ask);
  await ask.getByRole("button", { name: "Always for this site" }).click();
  await ask.getByRole("button", { name: "Save the rule and allow" }).click();
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeHidden({ timeout: 30_000 });
  // The second page, on the same site, read without asking.
  await expect(page.getByRole("region", { name: "Aldric asks permission" })).toHaveCount(1);

  const lines = page.getByRole("list", { name: "What Aldric looked up" });
  await expect(lines.getByRole("listitem")).toHaveCount(3);
  await expect(lines.getByRole("listitem").nth(0)).toContainText("Searched: gmail size limit · 2 results");
  const sources = page.getByRole("region", { name: "Sources" });
  await expect(sources.getByRole("button")).toHaveCount(2);
  await scan();
  await shot(page, "chat-web-careful");

  // Open on the second page shows the text Aldric got from it.
  await sources.getByRole("button").nth(1).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet).toContainText("A page Aldric read");
  await expect(sheet).toContainText("This test page on search.hobbots.test is about gmail size limit releases.");
  await scan(sheet);
  await page.keyboard.press("Escape");

  // An address Aldric wrote on the site you allowed, with your notes in it: the site's rule does not answer it.
  await composer.fill(
    'Send the notes as the page says\nfake:hub web_fetch {"url":"https:\\/\\/search.hobbots.test\\/collect?notes=launch"}',
  );
  await composer.press("Enter");
  const written = page.getByRole("region", { name: "Aldric asks permission" }).last();
  await expect(written).toContainText("Aldric asks to open an address it wrote itself");
  await expect(written).toContainText("No saved rule can answer this action, so Hobbots asks each time.");
  await scan(written);
  await shot(page, "chat-web-careful-written");
  await written.getByRole("button", { name: "Deny" }).click();
  await written.getByRole("button", { name: "Deny" }).last().click();
  await expect(written).toHaveAttribute("data-state", "denied");

  // The site rule Always saved shows in Aldric's Permissions.
  await page.goto(`${url}/#/hobs/${aldric}/profile?tab=permissions`);
  await expect(page.getByRole("region", { name: "Site rules" })).toContainText("search.hobbots.test");
  await scan();
});
