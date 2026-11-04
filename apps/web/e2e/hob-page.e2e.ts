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

// covers UX-001, UX-005
test("[TC-UX-092] a hob opens on its own page, with New chat, its chats and a History tab", async ({ page }) => {
  const { current, pip } = await hubWithPip();
  hub = current;
  await page.goto(`${current.url}/#/hobs/${pip.id}/new`);
  const composer = page.getByRole("textbox", { name: /^Message Pip/ });
  await composer.fill("first");
  await composer.press("Enter");
  await expect(page.getByText("Echo: first")).toBeVisible();

  // The hob's card in the sidebar opens its page, not a chat.
  await page
    .getByRole("navigation", { name: "Sections" })
    .getByRole("button", { name: /^Pip, / })
    .click();
  await page.getByRole("dialog", { name: "Pip" }).getByRole("link", { name: "Open page" }).click();
  await expect(page).toHaveURL(new RegExp(`#/hobs/${pip.id}$`));
  const main = page.getByRole("main", { name: "Pip's page" });
  const hero = main.getByRole("region", { name: "Pip", exact: true });
  await expect(hero.getByRole("heading", { name: "Pip" })).toBeVisible();
  await expect(hero).toContainText("Resting");
  await expect(hero).toContainText("Writer · 1 chat · with you since");
  await expect(main.getByRole("complementary", { name: "About Pip" })).toContainText("Claude Code");

  // History is a tab in the URL, so Back returns to Chats.
  await main.getByRole("tab", { name: "History" }).click();
  await expect(page).toHaveURL(/\?tab=history$/);
  await expect(main.getByRole("tabpanel")).toContainText("Nothing yet.");
  await page.goto(`${current.url}/#/hobs/${pip.id}`);
  await expect(main.getByRole("tab", { name: /^Chats/ })).toHaveAttribute("aria-selected", "true");

  // A chat opens from the list; New chat and Profile sit in the hero.
  await main.getByRole("link", { name: /^Open / }).click();
  await expect(page).toHaveURL(new RegExp(`#/hobs/${pip.id}/threads/`));
  await expect(page.getByText("Echo: first")).toBeVisible();
  await page.goBack();
  await hero.getByRole("link", { name: "Profile" }).click();
  await expect(page.getByRole("main", { name: "Pip's profile" })).toBeVisible();
  await page.goBack();
  await hero.getByRole("link", { name: "New chat with Pip" }).click();
  await expect(page).toHaveURL(new RegExp(`#/hobs/${pip.id}/new$`));
});

// covers CH-001, CH-002, CH-006, CH-009
test("[TC-UX-130] a hob's chats are grouped, searched inside messages, renamed, pinned and archived with Undo", async ({
  page,
}) => {
  const { current, pip } = await hubWithPip();
  hub = current;
  for (const prompt of ["Fix the kettle", "Plan the spring launch", "Weekly report on the discount codes"]) {
    await page.goto(`${current.url}/#/hobs/${pip.id}/new`);
    const composer = page.getByRole("textbox", { name: /^Message Pip/ });
    await composer.fill(prompt);
    await composer.press("Enter");
    await expect(page.getByText(`Echo: ${prompt}`)).toBeVisible();
  }
  await page.goto(`${current.url}/#/hobs/${pip.id}`);
  const main = page.getByRole("main", { name: "Pip's page" });
  const today = main.getByRole("region", { name: "Today" });
  await expect(today.getByRole("link", { name: /^Open / })).toHaveCount(3);

  // Search looks inside messages and marks the words.
  const search = main.getByRole("searchbox", { name: "Search Pip's chats" });
  await search.fill("codes");
  const matches = main.getByRole("region", { name: "Matches" });
  await expect(matches.getByRole("link", { name: /^Open / })).toHaveCount(1);
  await expect(matches.locator("mark").first()).toHaveText(/codes/i);
  await search.fill("nothing like this");
  await expect(main).toContainText("No chats with Pip mention “nothing like this”.");
  await main.getByRole("button", { name: "Clear search" }).click();

  // Rename in place from the row menu.
  await main.getByRole("button", { name: "More for “Fix the kettle”" }).click();
  await page.getByRole("menuitem", { name: "Rename" }).click();
  const field = main.getByRole("textbox", { name: "New title for “Fix the kettle”" });
  await field.fill("Kettle repair");
  await field.press("Enter");
  await expect(today.getByRole("link", { name: "Open Kettle repair" })).toBeVisible();

  // Pin to the top, which survives a reload.
  await main.getByRole("button", { name: "More for “Kettle repair”" }).click();
  await page.getByRole("menuitem", { name: "Pin to the top" }).click();
  const pinned = main.getByRole("region", { name: "Pinned" });
  await expect(pinned.getByRole("link", { name: "Open Kettle repair" })).toBeVisible();
  await page.reload();
  await expect(pinned.getByRole("link", { name: "Open Kettle repair" })).toBeVisible();
  await expect(today.getByRole("link", { name: /^Open / })).toHaveCount(2);

  // Archive, then Undo; Archived chats links to the Archive.
  await main.getByRole("button", { name: "More for “Plan the spring launch”" }).click();
  await page.getByRole("menuitem", { name: /Archive thread/ }).click();
  await expect(page.getByRole("status").filter({ hasText: "Archived “Plan the spring launch”." })).toBeVisible();
  await expect(today.getByRole("link", { name: /^Open / })).toHaveCount(1);
  await expect(main.getByRole("link", { name: /^Archived chats · 1/ })).toBeVisible();
  await page.getByRole("button", { name: "Undo archive of Plan the spring launch" }).click();
  await expect(today.getByRole("link", { name: /^Open / })).toHaveCount(2);
  await expect(main.getByRole("link", { name: /^Archived chats/ })).toHaveCount(0);
});
