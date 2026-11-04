import type { BrowserContext, Page, Request, Route } from "@playwright/test";
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

/** A hub past onboarding, with the stand-in keychain, and one hob, Pip, on its Charms tab. */
const openPipCharms = async (page: Page): Promise<{ current: Hub; pipId: string }> => {
  const current = await startHub(dataDir, { HOBBOTS_FAKE_GITHUB: "on" });
  const post = (path: string, method: string, body: unknown) =>
    fetch(`${current.url}${path}`, {
      method,
      headers: { ...current.headers, "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then((response) => response.json() as Promise<{ readonly id: string }>);
  await post("/api/setup", "PATCH", { completed: true, connectedProviders: ["claude-code"] });
  const pip = await post("/api/agents", "POST", {
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
    instructions: "Write short answers.",
  });
  await page.goto(`${current.url}/#/hobs/${pip.id}/profile`);
  await page.getByRole("tab", { name: "Charms" }).click();
  return { current, pipId: pip.id };
};

const app = {
  appId: 7,
  clientId: "Iv23pip",
  slug: "pip-hobbots",
  owner: "otaviobarros",
  botUserId: 90_000_007,
  htmlUrl: "https://github.com/apps/pip-hobbots",
  connectedAt: "2026-11-02T12:00:00.000Z",
};
const installUrl = "https://github.com/apps/pip-hobbots/installations/new";
const deleteUrl = "https://github.com/settings/apps/pip-hobbots/advanced";

const connected = (needsReconnect: { reason: "key" | "installation"; message: string } | null = null) => ({
  _tag: "Connected",
  app,
  bot: "pip-hobbots[bot]",
  installUrl,
  deleteUrl,
  needsReconnect,
});

/**
 * Stands in for the hub's answers about Pip's app, as GitHub would leave them, and records each
 * change asked for. Reading `status` and `installations` answers what the test set last.
 */
const standIn = async (page: Page, initial: { status: unknown; installations?: ReadonlyArray<unknown> }) => {
  const state: {
    status: unknown;
    installations: ReadonlyArray<unknown>;
    /** When set, reading the installations fails, as when GitHub refuses the app's key, and the hub marks it so. */
    refusing: unknown;
  } = { ...initial, installations: initial.installations ?? [], refusing: null };
  const asked: Array<string> = [];
  const disconnects: Array<unknown> = [];
  await page.route("**/api/agents/*/github-app**", (route: Route, request: Request) => {
    const path = new URL(request.url()).pathname.replace(/^\/api\/agents\/[^/]+\/github-app/, "");
    asked.push(`${request.method()} ${path === "" ? "/" : path}`);
    const answer = (body: unknown) => route.fulfill({ json: body });
    if (path === "") return answer(state.status);
    if (path === "/installations" && state.refusing !== null) {
      state.status = state.refusing;
      return route.fulfill({ status: 502, json: { _tag: "GitHubFailed", message: "GitHub refused the app's key." } });
    }
    if (path === "/installations") return answer({ installations: state.installations });
    if (path === "/disconnect") return answer(disconnects.shift() ?? { deleteUrl, problem: null });
    return route.continue();
  });
  return { state, asked, disconnects };
};

/** GitHub itself is not reached: the manifest the hub's page posts there is kept, and an empty page shown. */
const catchManifests = async (context: BrowserContext) => {
  const manifests: Array<Record<string, unknown>> = [];
  await context.route("https://github.com/**", (route) => {
    const body = route.request().postData();
    if (body !== null) manifests.push(JSON.parse(new URLSearchParams(body).get("manifest") ?? "{}"));
    return route.fulfill({ body: "" });
  });
  return manifests;
};

// covers PE-002
test("[TC-GEN-056] gives a hob its own GitHub app from its Charms tab and shows where it is installed", async ({
  page,
  context,
}) => {
  const { current } = await openPipCharms(page);
  hub = current;
  const manifests = await catchManifests(context);
  const section = page.getByRole("region", { name: "Acts on GitHub as" });

  // By default Pip acts as you.
  await expect(section.getByText("Pip acts as you", { exact: false })).toBeVisible();

  // The hub's page opens in the browser and posts Pip's manifest to GitHub.
  const opened = context.waitForEvent("page");
  await section.getByRole("button", { name: "Make its app" }).click();
  const github = await opened;
  await expect.poll(() => manifests.length).toBe(1);
  expect(manifests[0]).toMatchObject({ name: "pip-hobbots", public: false });
  await github.close();
  await expect(section.getByText("Finish on GitHub", { exact: false })).toBeVisible();
  await expect(section.getByRole("link", { name: "Open GitHub again" })).toHaveAttribute(
    "href",
    new RegExp(`^${current.url}/github/hob-app/new\\?state=`),
  );

  // Each start works once, so a page GitHub sent back with an error is fixed by starting again,
  // which opens a fresh page.
  const first = await section.getByRole("link", { name: "Open GitHub again" }).getAttribute("href");
  const reopened = context.waitForEvent("page");
  await section.getByRole("button", { name: "Start again" }).click();
  const again = await reopened;
  await expect.poll(() => manifests.length).toBe(2);
  await again.close();
  await expect(section.getByRole("link", { name: "Open GitHub again" })).not.toHaveAttribute("href", first ?? "");

  // A start that runs out offers a new one; Cancel does too, at once.
  await section.getByRole("button", { name: "Cancel" }).click();
  await expect(section.getByText("Finish on GitHub", { exact: false })).toBeHidden();
  await page.route("**/api/agents/*/github-app/start", (route) =>
    route.fulfill({
      json: {
        url: `${current.url}/github/hob-app/new?state=gone`,
        expiresAt: new Date(Date.now() + 1500).toISOString(),
      },
    }),
  );
  const expiring = context.waitForEvent("page");
  await section.getByRole("button", { name: "Make its app" }).click();
  await (await expiring).close();
  await expect(section.getByText("Finish on GitHub", { exact: false })).toBeVisible();
  await expect(section.getByText("The last start ran out", { exact: false })).toBeVisible({ timeout: 5_000 });
  await expect(section.getByRole("button", { name: "Make its app" })).toBeVisible();
  await page.unroute("**/api/agents/*/github-app/start");

  // GitHub made the app: the tab follows it while you are there, and asks you to install it.
  const { state } = await standIn(page, { status: connected() });
  await expect(section.getByRole("link", { name: "pip-hobbots[bot]" })).toHaveAttribute("href", app.htmlUrl);
  await expect(section.getByText("Not installed on any repository yet", { exact: false })).toBeVisible();
  // The Charm acts as Pip's bot, so it needs no account connected in Settings.
  await expect(
    page.getByText("comments on the repository of Pip's folders, as pip-hobbots[bot]", { exact: false }),
  ).toBeVisible();
  await expect(page.getByText("GitHub is not connected on this hub yet")).toBeHidden();
  await expect(section.getByRole("link", { name: "Install on GitHub" })).toHaveAttribute("href", installUrl);

  // You install it on GitHub: the tab lists where, with where to change it.
  await context.route(installUrl, (route) => route.fulfill({ body: "" }));
  const installing = context.waitForEvent("page");
  await section.getByRole("link", { name: "Install on GitHub" }).click();
  await (await installing).close();
  state.installations = [
    {
      id: 41,
      account: "otaviobarros",
      repositorySelection: "selected",
      htmlUrl: "https://github.com/settings/installations/41",
      suspended: false,
      repositories: ["otaviobarros/pip-notes", "frodo/shire-maps"],
    },
  ];
  const installed = section.getByRole("list", { name: "Installed on" });
  await expect(installed).toContainText("@otaviobarros: the repositories you picked", { timeout: 10_000 });
  // Each repository it reaches is named, without the account when it is the installation's.
  const reached = installed.getByRole("list", { name: "Repositories @otaviobarros lets it reach" });
  await expect(reached.getByRole("listitem")).toHaveText(["pip-notes", "frodo/shire-maps"]);
  await expect(installed.getByRole("link", { name: "Change on GitHub" })).toHaveAttribute(
    "href",
    "https://github.com/settings/installations/41",
  );
  // No key or token reaches the page.
  expect(await page.content()).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY|gh[ousr]_/);
});

// covers PE-002
test("[TC-GEN-057] fixes a hob's app that needs a reconnect in one action", async ({ page, context }) => {
  const { current } = await openPipCharms(page);
  hub = current;
  const manifests = await catchManifests(context);
  const section = page.getByRole("region", { name: "Acts on GitHub as" });

  // The key is revoked while the tab is open on a connected app: reading where it is installed is
  // refused, which marks it on the hub. Only that read is asked again, and the tab shows the fix.
  const { state, asked, disconnects } = await standIn(page, { status: connected() });
  state.refusing = connected();
  await page.reload();
  await page.getByRole("tab", { name: "Charms" }).click();
  const failed = section.getByRole("alert").filter({ hasText: "could not ask GitHub where the app is installed" });
  await expect(failed).toBeVisible({ timeout: 15_000 });
  state.refusing = connected({ reason: "key", message: "GitHub refused the app's key." });
  await failed.getByRole("button", { name: "Try again" }).click();
  const alert = section.getByRole("alert").filter({ hasText: "Needs a reconnect" });
  await expect(alert.getByRole("button", { name: "Give Pip a new app" })).toBeVisible();
  state.refusing = null;

  // Uninstalled: one action, reinstalling it on GitHub.
  state.status = connected({ reason: "installation", message: "GitHub refused the app's installation." });
  await page.reload();
  await page.getByRole("tab", { name: "Charms" }).click();
  await expect(alert).toContainText("Needs a reconnect");
  await expect(alert).toContainText("never run as you");
  await expect(alert.getByRole("link", { name: "Reinstall on GitHub" })).toHaveAttribute("href", installUrl);

  // Key refused: one action replaces the app. The old one is removed, and dismissed when something of
  // it is left, then a new one is started.
  state.status = connected({ reason: "key", message: "GitHub refused the app's key." });
  await page.reload();
  await page.getByRole("tab", { name: "Charms" }).click();
  await expect(alert.getByRole("link", { name: "Reinstall on GitHub" })).toBeHidden();
  disconnects.push({ deleteUrl, problem: "The hub could not remove the app's installations." });
  disconnects.push({ deleteUrl, problem: null });
  asked.length = 0;
  const opened = context.waitForEvent("page");
  await page.route("**/api/agents/*/github-app/start", (route) => {
    asked.push("POST /start");
    state.status = { _tag: "None", cannotCreate: null };
    return route.continue();
  });
  // The hub still has no app for Pip, so the real start answers.
  await alert.getByRole("button", { name: "Give Pip a new app" }).click();
  const github = await opened;
  await expect.poll(() => manifests.length).toBe(1);
  await github.close();
  expect(asked.filter((each) => each !== "GET /" && each !== "GET /installations")).toEqual([
    "POST /disconnect",
    "POST /disconnect",
    "POST /start",
  ]);
  await expect(section.getByText("Finish on GitHub", { exact: false })).toBeVisible();
  await expect(section.getByRole("link", { name: "Delete the app on GitHub" })).toHaveAttribute("href", deleteUrl);
});

// covers PE-002
test("[TC-GEN-058] disconnects a hob's app after asking, and shows an old app that was not fully removed", async ({
  page,
}) => {
  const { current } = await openPipCharms(page);
  hub = current;
  const section = page.getByRole("region", { name: "Acts on GitHub as" });
  const { state, asked } = await standIn(page, {
    status: connected(),
    installations: [
      {
        id: 41,
        account: "otaviobarros",
        repositorySelection: "all",
        htmlUrl: "https://github.com/settings/installations/41",
        suspended: false,
        repositories: Array.from({ length: 10 }, (_, at) => `otaviobarros/repo-${at + 1}`),
      },
    ],
  });
  await page.reload();
  await page.getByRole("tab", { name: "Charms" }).click();
  await expect(section.getByRole("list", { name: "Installed on" })).toContainText("@otaviobarros: every repository");
  // Past eight, the rest of the repositories are counted.
  const reached = section.getByRole("list", { name: "Repositories @otaviobarros lets it reach" }).getByRole("listitem");
  await expect(reached).toHaveCount(9);
  await expect(reached.last()).toHaveText("and 2 more");

  // Disconnect asks first; Keep it changes nothing.
  await section.getByRole("button", { name: "Disconnect its app…" }).click();
  await expect(section.getByText("Disconnect Pip's app?", { exact: false })).toBeVisible();
  await section.getByRole("button", { name: "Keep it" }).click();
  expect(asked).not.toContain("POST /disconnect");

  await section.getByRole("button", { name: "Disconnect its app…" }).click();
  state.status = { _tag: "None", cannotCreate: null };
  await section.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(section.getByRole("status")).toContainText("Disconnected. Pip acts as you again.");
  await expect(section.getByRole("link", { name: "Delete the app on GitHub" })).toHaveAttribute("href", deleteUrl);
  await expect(section.getByRole("button", { name: "Make its app" })).toBeVisible();

  // An old app the hub could not fully remove stays shown, with where to delete it, until dismissed.
  state.status = { _tag: "LeftOver", app, problem: "1 of the app's installations could not be removed.", deleteUrl };
  await page.reload();
  await page.getByRole("tab", { name: "Charms" }).click();
  const left = section.getByRole("alert");
  await expect(left).toContainText("Pip's old app was not fully removed");
  await expect(left).toContainText("It no longer acts. 1 of the app's installations could not be removed.");
  await expect(left.getByRole("link", { name: "Delete the app on GitHub" })).toHaveAttribute("href", deleteUrl);
  state.status = { _tag: "None", cannotCreate: null };
  await left.getByRole("button", { name: "Dismiss" }).click();
  await expect(section.getByRole("button", { name: "Make its app" })).toBeVisible();
});
