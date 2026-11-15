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

/** A hub past onboarding with one hob, Pip, made through the API as Summon makes it. */
const hubWithPip = async () => {
  const current = await startHub(dataDir);
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
    model: null,
    effort: null,
    instructions: "Write short answers.",
  });
  return { current, pip };
};

test("a hob opens on its own page, with New chat, its chats and a History tab", async ({ page }) => {
  const { current, pip } = await hubWithPip();
  hub = current;
  await page.goto(`${current.url}/#/hobs/${pip.id}/chat`);
  const composer = page.getByRole("textbox", { name: /^Message Pip/ });
  await composer.fill("first");
  await composer.press("Enter");
  await expect(page.getByRole("main").getByText("Echo: first")).toBeVisible();

  await page.goto(`${current.url}/#/hobs/${pip.id}`);
  await expect(page).toHaveURL(new RegExp(`#/hobs/${pip.id}$`));
  const main = page.getByRole("main", { name: "Pip's page" });
  const hero = main.getByRole("region", { name: "Pip", exact: true });
  await expect(hero.getByRole("heading", { name: "Pip" })).toBeVisible();
  await expect(hero).toContainText("Resting");
  await expect(hero).toContainText("Writer · 1 chat · with you since");
  await expect(main.getByRole("complementary", { name: "About Pip" })).toContainText("Claude Code");
  // Each chat shows its last line under its title.
  await expect(main.getByRole("tabpanel", { name: /^Chats/ })).toContainText("Echo: first");

  // History is a tab in the URL, so Back returns to Chats.
  await main.getByRole("tab", { name: "History" }).click();
  await expect(page).toHaveURL(/\?tab=history$/);
  await expect(main.getByRole("tabpanel")).toContainText("Nothing yet.");
  await page.goto(`${current.url}/#/hobs/${pip.id}`);
  await expect(main.getByRole("tab", { name: /^Chats/ })).toHaveAttribute("aria-selected", "true");

  // A chat opens from the list; New chat and Profile sit in the hero.
  await main.getByRole("link", { name: /^Open / }).click();
  await expect(page).toHaveURL(new RegExp(`#/hobs/${pip.id}/threads/`));
  await expect(page.getByRole("main").getByText("Echo: first")).toBeVisible();
  await page.goBack();
  await hero.getByRole("link", { name: "Profile" }).click();
  await expect(page.getByRole("main", { name: "Pip's profile" })).toBeVisible();
  await page.goBack();
  await hero.getByRole("link", { name: "Your chat with Pip" }).click();
  // The hob already has its chat, so the hero opens that one.
  await expect(page).toHaveURL(new RegExp(`#/hobs/${pip.id}/threads/`));
  await expect(page.getByRole("main").getByText("Echo: first")).toBeVisible();
});
