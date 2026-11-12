import { emptyDataDir, expect, type Hub, removeDataDir, startHub, test } from "./hub.ts";

let hub: Hub | undefined;
let dataDir = "";

test.afterEach(async () => {
  await hub?.stop();
  hub = undefined;
  removeDataDir(dataDir);
});

// covers AG-001
test("[TC-AG-082] picking a role by keyboard alone dresses the hob, and a custom title with a borrowed sigil is saved and changed from the profile", async ({
  page,
}) => {
  dataDir = emptyDataDir();
  const current = await startHub(dataDir);
  hub = current;
  const setup = await fetch(`${current.url}/api/setup`, {
    method: "PATCH",
    headers: { "content-type": "application/json", ...current.headers },
    body: JSON.stringify({ completed: true, connectedProviders: ["claude-code"] }),
  });
  expect(setup.ok).toBe(true);

  await page.goto(`${current.url}/#/summon`);
  await expect(page.getByRole("heading", { name: "What should your new hob help you with?" })).toBeVisible();

  // One radio group runs through the eight common roles, so arrow keys move from one to the next.
  const roles = page.getByRole("group", { name: "Role" });
  const chores = page.getByRole("textbox", { name: "What it should do, in your words" });
  await roles.getByRole("radio", { name: /^Assistant/ }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(roles.getByRole("radio", { name: /^Researcher/ })).toBeChecked();
  await expect(chores).toHaveValue(/Link every source you used/);

  // Every role is one click further, in the role sheet; a role from there stays in view, checked.
  await page.getByRole("button", { name: "See all 54 roles" }).press("Enter");
  const allRoles = page.getByRole("dialog", { name: "Pick a role" });
  await allRoles.getByText("Editor", { exact: true }).click();
  await allRoles.getByRole("button", { name: "Pick Editor" }).click();
  await expect(allRoles).toBeHidden();
  await expect(roles.getByRole("radio", { name: /^Editor/ })).toBeChecked();

  // A title of your own replaces the role and asks for a sigil, picked by keyboard alone.
  const title = page.getByRole("textbox", { name: "Your own role title" });
  await title.focus();
  await page.keyboard.type("Frontend wizard");
  await expect(roles.getByRole("radio", { checked: true })).toHaveCount(0);
  await page.keyboard.press("Tab");
  await expect(page.getByRole("radio", { name: "Assistant's sigil", exact: true })).toBeFocused();
  for (let i = 0; i < 16; i++) await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("radio", { name: "Frontend engineer's sigil" })).toBeChecked();

  const suggest = page.getByRole("link", { name: "Missing a role? Suggest one" });
  const href = new URL((await suggest.getAttribute("href")) ?? "");
  expect(href.searchParams.get("template")).toBe("5-role-request.yml");
  expect(href.searchParams.get("role-title")).toBe("Frontend wizard");
  await page.getByRole("button", { name: "Next: name and look" }).click();

  // The name, hat and tool are on the second step; a title of your own leaves the gear to the look.
  await expect(page).toHaveURL(/step=look/);
  await page.getByRole("textbox", { name: "Hob name" }).fill("Fern");
  const hat = page.getByRole("group", { name: "Hat" });
  const tool = page.getByRole("group", { name: "Tool" });
  await expect(hat.getByRole("radio", { name: "From the look" })).toBeChecked();
  await hat.getByRole("radio", { name: "Tiny crown" }).check({ force: true });
  await tool.getByRole("radio", { name: "Wand" }).check({ force: true });
  await page.getByRole("button", { name: "Next: check and summon" }).click();

  await expect(page.getByRole("heading", { name: "Ready to summon Fern?" })).toBeVisible();
  await expect(page.getByRole("definition").filter({ hasText: "Frontend wizard" })).toBeVisible();
  await page.getByRole("button", { name: "Summon Fern" }).focus();
  await page.keyboard.press("Enter");
  // The summoning plays, then Fern arrives with first questions; one opens the chat with it typed in.
  await expect(page).toHaveURL(/#\/hobs\/[^/]+\/arrived$/);
  await expect(page.getByRole("heading", { name: "Fern is here!" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Open Fern's profile" })).toBeVisible();
  await page
    .getByRole("region", { name: "Try asking" })
    .getByRole("link", { name: /What can you help me with/ })
    .click();
  await expect(page).toHaveURL(/#\/hobs\/[^/]+\/chat$/);
  await expect(page.getByRole("textbox", { name: /^Message Fern/ })).toHaveValue("What can you help me with?");

  const hobs = (await (await fetch(`${current.url}/api/agents`, { headers: current.headers })).json()) as ReadonlyArray<
    Record<string, unknown>
  >;
  const fern = hobs.find((h) => h.name === "Fern");
  expect(fern).toMatchObject({
    role: null,
    roleTitle: "Frontend wizard",
    sigil: "frontend",
    hat: "crown",
    tool: "wand",
  });

  await page.goto(`${current.url}/#/hobs/${String(fern?.id)}/profile`);
  const profile = page.getByRole("main", { name: "Fern's profile" });
  await expect(profile.locator("header")).toContainText("Frontend wizard");

  // The profile changes the role from the same dialog: families on the left, roles on the right.
  await profile.getByRole("button", { name: "Change role" }).click();
  const sheet = page.getByRole("dialog", { name: "Pick a role" });
  await expect(sheet.getByRole("radio", { name: /^Your own/ })).toBeChecked();
  await expect(sheet.getByRole("textbox", { name: "Your own role title" })).toHaveValue("Frontend wizard");
  await expect(sheet.getByRole("button", { name: "Use your own title" })).toBeEnabled();
  await sheet.getByRole("button", { name: /^Leadership/ }).click();
  await expect(sheet.getByRole("region", { name: "Leadership" })).toBeVisible();
  await expect(sheet.getByRole("region", { name: "Everyday helpers" })).toBeHidden();
  await sheet.getByRole("button", { name: /^All roles/ }).click();
  await sheet.getByText("Writer", { exact: true }).click();
  await expect(sheet.getByRole("radio", { name: /^Writer Drafts/ })).toBeChecked();
  await sheet.getByRole("button", { name: "Pick Writer" }).click();
  await expect(sheet).toBeHidden();

  // The hub tells the hob its role on every turn, so the instructions never name it.
  await expect(profile.getByRole("textbox", { name: "What Fern should do" })).not.toHaveValue(/a hob in Hobbots/);
  await profile.getByRole("button", { name: "Save changes" }).click();
  await expect
    .poll(async () => {
      const after = (await (
        await fetch(`${current.url}/api/agents`, { headers: current.headers })
      ).json()) as ReadonlyArray<Record<string, unknown>>;
      return after.find((h) => h.name === "Fern");
    })
    .toMatchObject({
      role: "writer",
      roleTitle: "Writer",
      sigil: "writer",
      instructions: expect.not.stringContaining("a hob in Hobbots"),
    });
});
