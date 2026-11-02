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

const api = async <A>(current: Hub, method: string, path: string, body?: unknown): Promise<A> => {
  const response = await fetch(`${current.url}${path}`, {
    method,
    headers: { ...current.headers, ...(body !== undefined && { "content-type": "application/json" }) },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${method} ${path} answered ${response.status}: ${await response.text()}`);
  return (await response.json()) as A;
};

// covers PE-002
test("[TC-GEN-024] connects GitHub in Settings and grants it per hob on the Charms tab", async ({ page }) => {
  // Stand-ins for GitHub's sign-in and the keychain: the code is entered a second after Connect.
  hub = await startHub(dataDir, { HOBBOTS_FAKE_GITHUB: "on" });
  const current = hub;
  await api(current, "PATCH", "/api/setup", { completed: true, connectedProviders: ["claude-code"] });
  const pip = await api<{ readonly id: string }>(current, "POST", "/api/agents", {
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

  // Nothing is connected yet: the hob has the Charm, but no hob can use GitHub.
  await page.goto(`${current.url}/#/hobs/${pip.id}/profile`);
  await page.getByRole("tab", { name: "Charms" }).click();
  const grant = page.getByRole("switch", { name: "Let Pip use GitHub" });
  await expect(grant).toBeChecked();
  await expect(page.getByText("GitHub is not connected on this hub yet")).toBeVisible();
  await page.getByRole("link", { name: "Connect GitHub in Settings" }).click();

  // The device flow shows the code, then the account once it is entered.
  const charms = page.getByRole("region", { name: "Charms" });
  await expect(charms.getByText("Your GitHub CLI sign-in, as @octohob")).toBeVisible();
  await charms.getByRole("button", { name: "Connect with Hobbots" }).click();
  await expect(charms.getByText("HOBS-0001")).toBeVisible();
  await expect(charms.getByRole("link", { name: "Open GitHub" })).toHaveAttribute(
    "href",
    "https://github.com/login/device",
  );
  await expect(charms.getByText(/Connected as @octohob since/)).toBeVisible({ timeout: 15_000 });
  await expect(charms.getByRole("list", { name: "Repositories it reaches" })).toContainText("octohob/workshop");
  await expect(charms.getByRole("list", { name: "What the app may do there" })).toContainText(
    "Pull requests: read and write",
  );
  await expect(charms.getByRole("link", { name: "Choose repositories on GitHub" })).toHaveAttribute(
    "href",
    "https://github.com/apps/hobbots/installations/new",
  );
  // No token reaches the page.
  expect(await page.content()).not.toMatch(/gh[ousr]_/);

  // Taking the Charm from Pip saves a new version; giving it back drops the override.
  await page.goto(`${current.url}/#/hobs/${pip.id}/profile`);
  await page.getByRole("tab", { name: "Charms" }).click();
  await expect(page.getByText("GitHub is not connected on this hub yet")).toBeHidden();
  await grant.click();
  await expect(page.getByText("Pip is offered no GitHub action until you turn this on.")).toBeVisible();
  await expect
    .poll(() => api<{ policy: object }>(current, "GET", `/api/agents/${pip.id}/permissions`))
    .toMatchObject({ policy: { githubCharm: false } });
  await grant.click();
  await expect(grant).toBeChecked();

  // Disconnecting points at GitHub, where the app stays authorized until it is revoked there.
  await page.goto(`${current.url}/#/settings`);
  await charms.getByRole("button", { name: "Disconnect" }).click();
  await expect(charms.getByRole("link", { name: "Open authorized apps on GitHub" })).toBeVisible();
  await expect(charms.getByRole("button", { name: "Connect with Hobbots" })).toBeVisible();

  // A sign-in already on the computer connects in one click.
  await charms.getByRole("button", { name: "Use" }).click();
  await expect(charms.getByText(/Through your GitHub CLI sign-in/)).toBeVisible();
  await expect(charms.getByText("Reaches every repository @octohob can see.", { exact: false })).toBeVisible();
});

// covers PE-002
test("[TC-GEN-040] shows a repository added on GitHub while Hobbots stays open beside the browser", async ({
  page,
  context,
}) => {
  hub = await startHub(dataDir, { HOBBOTS_FAKE_GITHUB: "on" });
  const current = hub;
  await api(current, "PATCH", "/api/setup", { completed: true, connectedProviders: ["claude-code"] });
  // GitHub itself is not reached: the page it opens is empty.
  await context.route("https://github.com/**", (route) => route.fulfill({ body: "" }));

  await page.goto(`${current.url}/#/settings`);
  const charms = page.getByRole("region", { name: "Charms" });
  await charms.getByRole("button", { name: "Connect with Hobbots" }).click();
  const reached = charms.getByRole("list", { name: "Repositories it reaches" });
  await expect(reached).toContainText("octohob/workshop", { timeout: 15_000 });
  await expect(reached).not.toContainText("octohob/notes");

  // You go to GitHub to choose repositories: Hobbots loses focus but stays on screen.
  const github = context.waitForEvent("page");
  await charms.getByRole("link", { name: "Choose repositories on GitHub" }).click();
  await (await github).close();
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));

  // The stand-in lists a second repository a few seconds later, as if you added it there.
  await expect(reached).toContainText("octohob/notes", { timeout: 20_000 });
});
