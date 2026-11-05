import { randomUUID } from "node:crypto";

import { emptyDataDir, expect, type Hub, removeDataDir, startHub, test } from "./hub.ts";

let hub: Hub | undefined;
let dataDir = "";

test.afterEach(async () => {
  await hub?.stop();
  hub = undefined;
  removeDataDir(dataDir);
});

/** A hub past setup whose memory is the fake in `memory`, looked at every `lookSeconds`. */
const hubWithMemory = async (memory: "empty" | "seeded" | "down", lookSeconds = 1) => {
  dataDir = emptyDataDir();
  hub = await startHub(dataDir, { HOBBOTS_FAKE_MEMORY: memory, HOBBOTS_MEMORY_LOOK_SECONDS: String(lookSeconds) });
  const started = hub;
  const call = async <A>(method: string, path: string, body?: unknown) => {
    const response = await fetch(`${started.url}/api${path}`, {
      method,
      headers: { "content-type": "application/json", ...started.headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
    return response.json() as Promise<A>;
  };
  const api = (method: string, path: string, body: unknown) => call<{ readonly id: string }>(method, path, body);
  await api("PATCH", "/setup", { completed: true, connectedProviders: ["claude-code"] });
  const summon = (name: string, lookSeed: number) =>
    api("POST", "/agents", {
      id: randomUUID(),
      name,
      role: null,
      roleTitle: "Writer",
      sigil: "assistant",
      hat: null,
      tool: null,
      lookSeed,
      lookColor: "moss",
      runtime: "claude-code",
      model: null,
      effort: null,
      instructions: "",
    });
  return { url: started.url, summon, call };
};

// covers ADR 028 (Browse, Read), #958
test("[TC-UX-951] Memory opens from the sidebar, shows what hobs learned, and reads a page with its changes", async ({
  page,
}) => {
  const { url, summon } = await hubWithMemory("seeded");
  const pip = await summon("Pip", 1201);
  await page.goto(`${url}/#/`);
  await page.getByRole("link", { name: "Memory", exact: true }).first().click();
  const main = page.getByRole("main", { name: "Memory" });
  await expect(main.getByRole("heading", { name: "Recently learned" })).toBeVisible();
  await expect(main.getByRole("link", { name: /Publishing a preview link/ })).toBeVisible();
  await expect(main).toContainText("Ask before sending anything outside the hub");

  // A hob's memory groups its pages by kind; a kind chip narrows the list.
  const nav = page.getByRole("navigation", { name: "Memory scopes" });
  await nav.getByRole("link", { name: /Pip/ }).click();
  await expect(page).toHaveURL(new RegExp(`scope=hob(%3A|:)${pip.id}`));
  await expect(main.getByRole("region", { name: "Gotchas" })).toBeVisible();
  await main.getByRole("radio", { name: /How-tos/ }).click();
  await expect(main.getByRole("region", { name: "Gotchas" })).toBeHidden();

  // A page reads as markdown, with its History; Show changes lays out what that version added.
  await main.getByRole("link", { name: /Publishing a preview link/ }).click();
  await expect(main.getByRole("heading", { name: "Publishing a preview link", level: 2 })).toBeVisible();
  await expect(main).toContainText("Learned by Pip");
  await main.getByRole("link", { name: "Show changes" }).click();
  await expect(main).toContainText("The first version of this page.");
  await expect(main.getByRole("listitem").filter({ hasText: "Copy the link from its result" }).first()).toBeVisible();
  await main.getByRole("link", { name: "Hide changes" }).click();
  await expect(main).not.toContainText("The first version of this page.");
});

// covers ADR 028 (Search, What changed), #958
test("[TC-UX-952] search finds pages across scopes, and What changed shows a new hob's saves as they land", async ({
  page,
}) => {
  const { url, summon } = await hubWithMemory("seeded");
  await summon("Pip", 1201);
  await page.goto(`${url}/#/memory`);
  const main = page.getByRole("main", { name: "Memory" });
  await page.getByRole("searchbox", { name: "Search memory" }).fill("preview");
  await page.getByRole("searchbox", { name: "Search memory" }).press("Enter");
  await expect(main.getByRole("heading", { name: /mention “preview”/ })).toBeVisible();
  await expect(main).toContainText("Publishing the site");
  await expect(main).toContainText("In Pip's memory");

  await page.getByRole("navigation", { name: "Memory scopes" }).getByRole("link", { name: "What changed" }).click();
  await expect(main.getByRole("heading", { name: "What changed", level: 2 })).toBeVisible();
  await expect(main).not.toContainText("Saved by Ada");
  // A hob summoned now saves its pages; the hub finds them within a look and streams them in.
  await summon("Ada", 1301);
  await expect(main.getByText("Saved by Ada").first()).toBeVisible({ timeout: 15_000 });
  await main.getByRole("radio", { name: /Yours/ }).click();
  await expect(main).not.toContainText("Saved by Ada");
});

// covers ADR 028 (Browse), #958
test("[TC-UX-953] with nothing remembered yet, Memory says how it fills", async ({ page }) => {
  const { url, summon } = await hubWithMemory("empty");
  await summon("Pip", 1201);
  await page.goto(`${url}/#/memory`);
  const main = page.getByRole("main", { name: "Memory" });
  await expect(main.getByRole("heading", { name: "Nothing remembered yet" })).toBeVisible();
  await expect(main).toContainText("A hob learns");
  await expect(page.getByText("1 hob · nothing remembered yet")).toBeVisible();
});

// covers ADR 028 (Browse), #958
test("[TC-UX-954] while memory is not answering, Memory says so and offers to try again", async ({ page }) => {
  const { url } = await hubWithMemory("down");
  await page.goto(`${url}/#/memory`);
  const main = page.getByRole("main", { name: "Memory" });
  await expect(main.getByText("Memory is not answering")).toBeVisible();
  await expect(page.getByText("Not answering · trying again every 30 seconds")).toBeVisible();
  await main.getByRole("button", { name: "Try again" }).click();
  await expect(main.getByText("Memory is not answering")).toBeVisible();
});

// covers ADR 028 (Browse), #958
test("[TC-UX-958] memory stopping after the page loaded shows the banner over what loaded, and clears when it answers again", async ({
  page,
}) => {
  // The hub never looks for changes during the test, so only the page's own reads find the outage.
  const { url, summon } = await hubWithMemory("seeded", 3600);
  await summon("Pip", 1201);
  await page.clock.install();
  await page.goto(`${url}/#/memory`);
  const main = page.getByRole("main", { name: "Memory" });
  await expect(page.getByText("1 hob · 8 pages · 2 shared places")).toBeVisible();
  await expect(main).toContainText("Ask before sending anything outside the hub");
  await expect(main.getByText("Memory is not answering")).toBeHidden();

  // Memory stops answering: the next look at the scopes, 30 seconds on, finds it down.
  const scopes = `${url}/api/memory/scopes`;
  await page.route(scopes, (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ _tag: "MemoryNotAnswering" }),
    }),
  );
  await page.clock.runFor(31_000);
  await expect(main.getByText("Memory is not answering")).toBeVisible();
  await expect(page.getByText("Not answering · trying again every 30 seconds")).toBeVisible();
  // What loaded stays on the page under the banner.
  await expect(main).toContainText("Ask before sending anything outside the hub");

  // Memory answers again: the next look clears the banner.
  await page.unroute(scopes);
  await page.clock.runFor(31_000);
  await expect(main.getByText("Memory is not answering")).toBeHidden();
  await expect(page.getByText("1 hob · 8 pages · 2 shared places")).toBeVisible();
  await expect(main).toContainText("Ask before sending anything outside the hub");
});

/** A hob's own page as the hub reads it now. */
type PageNow = { readonly page: { readonly version: string; readonly markdown: string } };

// covers ADR 028 (Edit, History), #959
test("[TC-UX-980] Edit saves a page as a new version by you, and Restore brings an older one back", async ({
  page,
}) => {
  const { url, summon } = await hubWithMemory("seeded");
  await summon("Pip", 1201);
  await page.goto(`${url}/#/memory`);
  const main = page.getByRole("main", { name: "Memory" });
  await main
    .getByRole("link", { name: /Publishing a preview link/ })
    .first()
    .click();
  await main.getByRole("link", { name: "Edit", exact: true }).click();
  await expect(page).toHaveURL(/edit=page/);
  await expect(main.getByLabel("Title")).toHaveValue("Publishing a preview link");

  const body = main.getByLabel("Page", { exact: true });
  await body.fill("Ask Pip for the preview link before writing the email.");
  await main.getByRole("button", { name: "Save", exact: true }).click();
  await expect(main.getByRole("status")).toContainText("Saved as a new version. Pip reads the new one");
  await expect(main).toContainText("Ask Pip for the preview link before writing the email.");
  await expect(main).not.toContainText("Copy the link from its result");

  // History keeps the version before, and Restore writes it back as a new version.
  await main
    .getByRole("button", { name: /^Restore the version from/ })
    .first()
    .click();
  await expect(main.getByRole("status")).toContainText("Restored this version.");
  await expect(main).toContainText("Copy the link from its result");
  await expect(main.getByRole("button", { name: /^Restore the version from/ }).first()).toBeVisible();
});

// covers ADR 028 (Pin, Forget, Delete), #959
test("[TC-UX-981] Pin, a forget day with Keep it, and Delete with Undo each change the page you read", async ({
  page,
}) => {
  const { url, summon } = await hubWithMemory("seeded");
  await summon("Pip", 1201);
  await page.goto(`${url}/#/memory`);
  const main = page.getByRole("main", { name: "Memory" });
  await main
    .getByRole("link", { name: /Publishing a preview link/ })
    .first()
    .click();
  const actions = main.getByRole("region", { name: "Actions" });

  await actions.getByRole("button", { name: "Pin", exact: true }).click();
  await expect(main.getByRole("status")).toContainText("Pinned.");
  await expect(actions.getByRole("button", { name: "Unpin" })).toHaveAttribute("aria-pressed", "true");

  // A forget day shows under the title until Keep it clears it.
  await actions.getByRole("button", { name: "Forget on a date…" }).click();
  await actions.getByLabel("Forget it on").fill("2099-01-31");
  await actions.getByRole("button", { name: "Set the day" }).click();
  await expect(main.getByRole("status")).toContainText("It will be forgotten after");
  await expect(main.getByText(/^Forgotten after/)).toBeVisible();
  await main.getByRole("button", { name: "Keep it" }).click();
  await expect(main.getByRole("status")).toContainText("Kept. It will not be forgotten.");
  await expect(main.getByText(/^Forgotten after/)).toBeHidden();

  // Delete asks first, leaves for the hob's memory, and Undo brings the page back.
  await actions.getByRole("button", { name: "Delete", exact: true }).click();
  await actions.getByRole("button", { name: "Delete it" }).click();
  await expect(main.getByRole("status")).toContainText("Deleted “Publishing a preview link”.");
  await expect(main.getByRole("link", { name: /Publishing a preview link/ })).toBeHidden();
  await main.getByRole("status").getByRole("button", { name: "Undo" }).click();
  await expect(main.getByRole("status")).toContainText("Brought it back.");
  await expect(main.getByRole("heading", { name: "Publishing a preview link", level: 2 })).toBeVisible();
});

// covers ADR 028 (Sharing: About you, Edit), #959
test("[TC-UX-982] a house rule and a new page are saved as your own pages", async ({ page }) => {
  const { url, summon } = await hubWithMemory("seeded");
  await summon("Pip", 1201);
  await page.goto(`${url}/#/memory`);
  const main = page.getByRole("main", { name: "Memory" });
  const nav = page.getByRole("navigation", { name: "Memory scopes" });
  await nav.getByRole("link", { name: /About you/ }).click();
  await main.getByRole("textbox", { name: "New house rule" }).fill("Keep customer emails short.");
  await main.getByRole("button", { name: "Add", exact: true }).click();
  await expect(main.getByRole("status")).toContainText("Added. Every hob follows it");
  await expect(main.getByRole("link", { name: /Keep customer emails short/ })).toBeVisible();
  await expect(main.getByRole("textbox", { name: "New house rule" })).toHaveValue("");

  await nav.getByRole("link", { name: /Pip/ }).click();
  await main.getByRole("link", { name: "New page" }).click();
  await main.getByRole("button", { name: "Save", exact: true }).click();
  await expect(main.getByText("Give the page a title.")).toBeVisible();
  await main.getByLabel("Title").fill("Ship on Tuesdays");
  await main.getByRole("radio", { name: "Decision" }).click();
  await main.getByLabel("Page", { exact: true }).fill("Agreed with you in the launch chat.");
  await main.getByRole("button", { name: "Save", exact: true }).click();
  await expect(main.getByRole("status")).toContainText("Saved. Hobs that read this memory find it");
  await expect(main.getByRole("heading", { name: "Ship on Tuesdays", level: 2 })).toBeVisible();
  await expect(page).toHaveURL(/decisions%2Fship-on-tuesdays\.md|decisions\/ship-on-tuesdays\.md/);
});

// covers ADR 028 (Edit), #959
test("[TC-UX-983] an edit that races a save keeps your text, and saves over it only when you say so", async ({
  page,
}) => {
  const { url, summon, call } = await hubWithMemory("seeded");
  const pip = await summon("Pip", 1201);
  const scope = `hob:${pip.id}`;
  const where = `/memory/page?${new URLSearchParams({ scope, path: "howtos/preview-link.md" })}`;
  await page.goto(`${url}/#/memory`);
  const main = page.getByRole("main", { name: "Memory" });
  await main
    .getByRole("link", { name: /Publishing a preview link/ })
    .first()
    .click();
  await main.getByRole("link", { name: "Edit", exact: true }).click();
  await main.getByLabel("Page", { exact: true }).fill("Mine: ask Pip for the link.");

  // The page is saved elsewhere while the editor is open.
  const opened = await call<PageNow>("GET", where);
  await call("POST", "/memory/page", {
    scope,
    path: "howtos/preview-link.md",
    markdown: "# Publishing a preview link\n\nTheirs: copy it from the task.\n",
    tags: [],
    pinned: false,
    forgetOn: null,
    expected: opened.page.version,
  });

  await main.getByRole("button", { name: "Save", exact: true }).click();
  await expect(main.getByRole("alert")).toContainText("saved this page while you were editing");
  await expect(main.getByLabel("Page", { exact: true })).toHaveValue("Mine: ask Pip for the link.");
  expect((await call<PageNow>("GET", where)).page.markdown).toContain("Theirs: copy it from the task.");

  await main.getByRole("button", { name: "Save mine over it" }).click();
  await expect(main.getByRole("status")).toContainText("Saved as a new version.");
  await expect(main).toContainText("Mine: ask Pip for the link.");
  // Theirs stays in the history, one Restore away.
  expect((await call<PageNow>("GET", where)).page.markdown).toContain("Mine: ask Pip for the link.");
  await expect(main.getByRole("button", { name: /^Restore the version from/ }).first()).toBeVisible();
});

// covers ADR 028 (Browse), #959
test("[TC-UX-984] Open folder shows memory's pages in the desktop app, and says when it could not", async ({
  page,
}) => {
  const { url } = await hubWithMemory("seeded");
  await page.addInitScript(() => {
    let calls = 0;
    Object.assign(window, { hobbots: { showMemoryFiles: async () => ++calls > 1 } });
  });
  await page.goto(`${url}/#/memory`);
  const main = page.getByRole("main", { name: "Memory" });
  await page.getByRole("button", { name: "Open folder" }).click();
  await expect(main.getByRole("alert")).toContainText("Hobbots could not open the folder.");
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("button", { name: "Open folder" })).toBeVisible();
});

// covers ADR 028 (Delete), #959
test("[TC-UX-985] a deleted page reads as gone when Back opens it again, not as it was", async ({ page }) => {
  const { url, summon } = await hubWithMemory("seeded");
  await summon("Pip", 1201);
  await page.goto(`${url}/#/memory`);
  const main = page.getByRole("main", { name: "Memory" });
  await main
    .getByRole("link", { name: /Publishing a preview link/ })
    .first()
    .click();
  await expect(main.getByRole("heading", { name: "Publishing a preview link", level: 2 })).toBeVisible();
  const actions = main.getByRole("region", { name: "Actions" });
  await actions.getByRole("button", { name: "Delete", exact: true }).click();
  await actions.getByRole("button", { name: "Delete it" }).click();
  await expect(main.getByRole("status")).toContainText("Deleted “Publishing a preview link”.");

  await page.goBack();
  await expect(main.getByRole("heading", { name: "This page is not in memory any more." })).toBeVisible();
  await expect(main.getByRole("heading", { name: "Publishing a preview link", level: 2 })).toBeHidden();
  await expect(main.getByRole("region", { name: "Actions" })).toBeHidden();
});

// covers ADR 028 (Delete), #959, STD-ARCH-011
test("[TC-UX-986] a page deleted in one window leaves another window's list, and its open page reads as gone", async ({
  page,
}) => {
  const { url, summon } = await hubWithMemory("seeded", 3600);
  const pip = await summon("Pip", 1201);
  const pageAddress = `${url}/#/memory?scope=hob:${pip.id}&page=howtos/preview-link.md`;
  await page.goto(pageAddress);
  const main = page.getByRole("main", { name: "Memory" });

  // Two more windows: one on Pip's list, one on the page itself.
  const list = await page.context().newPage();
  await list.goto(`${url}/#/memory?scope=hob:${pip.id}`);
  const listMain = list.getByRole("main", { name: "Memory" });
  await expect(listMain.getByRole("link", { name: /Publishing a preview link/ })).toBeVisible();
  const open = await page.context().newPage();
  await open.goto(pageAddress);
  const openMain = open.getByRole("main", { name: "Memory" });
  await expect(openMain.getByRole("heading", { name: "Publishing a preview link", level: 2 })).toBeVisible();

  const actions = main.getByRole("region", { name: "Actions" });
  await actions.getByRole("button", { name: "Delete", exact: true }).click();
  await actions.getByRole("button", { name: "Delete it" }).click();
  await expect(main.getByRole("status")).toContainText("Deleted");

  // The hub never looks for changes during the test: only the streamed delete reaches the others.
  await expect(listMain.getByRole("link", { name: /Publishing a preview link/ })).toBeHidden();
  await expect(openMain.getByRole("heading", { name: "This page is not in memory any more." })).toBeVisible();
});
