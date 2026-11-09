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
const useTheme = async (page: Page, theme: string) => {
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
    await useTheme(page, theme);
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
  await composer.fill(["Where are the launch images kept?", fetchPage("http://nas.hobbots.test/docs/shares")].join("\n"));
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
  await composer.fill('Check the stats\nfake:hub web_fetch {"url":"https:\\/\\/stats.hobbots.test\\/collect?from=you"}');
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
