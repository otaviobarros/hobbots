import { expect, test } from "@playwright/test";
import { emptyDataDir, type Hub, removeDataDir, startHub } from "./hub.ts";

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
  hub = await startHub(dataDir);
  const setup = await fetch(`${hub.url}/api/setup`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ completed: true, connectedProviders: ["claude-code"] }),
  });
  expect(setup.ok).toBe(true);

  await page.goto(`${hub.url}/#/summon`);
  await expect(page.getByRole("heading", { name: "Summon a hob" })).toBeVisible();
  await page.getByRole("textbox", { name: "Hob name" }).fill("Fern");

  // One radio group runs through the roles, so arrow keys move from one to the next.
  const roles = page.getByRole("group", { name: "Role" });
  const hat = page.getByRole("combobox", { name: "Hat" });
  const tool = page.getByRole("combobox", { name: "Tool" });
  const chores = page.getByRole("textbox", { name: "What should this hob do?" });
  await roles.getByRole("radio", { name: /^Assistant/ }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(roles.getByRole("radio", { name: /^Researcher/ })).toBeChecked();
  await expect(hat).toHaveValue("hood");
  await expect(tool).toHaveValue("lantern");
  await expect(chores).toHaveValue(/Link every source you used/);

  // "More roles" opens the families; the first family's roles follow the first eight.
  await roles.getByRole("button", { name: /^More roles/ }).press("Enter");
  await expect(roles.getByRole("group", { name: "Leadership" })).toBeVisible();
  await roles.getByRole("radio", { name: /^Researcher/ }).focus();
  // Past the first eight comes Everyday helpers' first other role, the Editor.
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect(roles.getByRole("radio", { name: /^Editor/ })).toBeChecked();
  await expect(hat).toHaveValue("wizard");

  // Back past the first role wraps to "Your own", which asks for a title right away.
  await roles.getByRole("radio", { name: /^Assistant/ }).focus();
  await page.keyboard.press("ArrowLeft");
  await expect(roles.getByRole("radio", { name: /^Your own/ })).toBeChecked();
  const title = page.getByRole("textbox", { name: "Your own role title" });
  await expect(title).toBeFocused();
  await page.keyboard.type("Frontend wizard");
  await expect(hat).toHaveValue("");

  // The sigils are their own radio group; Tab enters it on the one picked.
  await page.keyboard.press("Tab");
  await expect(page.getByRole("radio", { name: "Assistant's sigil", exact: true })).toBeFocused();
  for (let i = 0; i < 16; i++) await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("radio", { name: "Frontend engineer's sigil" })).toBeChecked();

  // The hat and tool stay changeable next to the look.
  await hat.focus();
  await hat.selectOption("crown");
  await tool.selectOption("wand");
  await expect(page.getByText("Look #").first()).toContainText("tiny crown, a wand");

  const suggest = page.getByRole("link", { name: "Missing a role? Suggest one" });
  const href = new URL((await suggest.getAttribute("href")) ?? "");
  expect(href.searchParams.get("template")).toBe("5-role-request.yml");
  expect(href.searchParams.get("role-title")).toBe("Frontend wizard");

  await page.getByRole("button", { name: "Summon Fern" }).focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#\/hobs\/[^/]+\/new/);

  const hobs = (await (await fetch(`${hub.url}/api/agents`)).json()) as ReadonlyArray<Record<string, unknown>>;
  const fern = hobs.find((h) => h.name === "Fern");
  expect(fern).toMatchObject({
    role: null,
    roleTitle: "Frontend wizard",
    sigil: "frontend",
    hat: "crown",
    tool: "wand",
  });

  await page.goto(`${hub.url}/#/hobs/${String(fern?.id)}/profile`);
  const profile = page.getByRole("main", { name: "Fern's profile" });
  await expect(profile.locator("header")).toContainText("Frontend wizard");

  // The profile changes the role on the same picker.
  const profileRoles = profile.getByRole("group", { name: "Role" });
  await expect(profileRoles.getByRole("radio", { name: /^Your own/ })).toBeChecked();
  await expect(page.getByRole("textbox", { name: "Your own role title" })).toHaveValue("Frontend wizard");
  await profileRoles.getByRole("radio", { name: /^Writer/ }).check();
  await profile.getByRole("button", { name: "Save changes" }).click();
  await expect
    .poll(async () => {
      const after = (await (await fetch(`${hub.url}/api/agents`)).json()) as ReadonlyArray<Record<string, unknown>>;
      return after.find((h) => h.name === "Fern");
    })
    .toMatchObject({ role: "writer", roleTitle: "Writer", sigil: "writer" });
});
