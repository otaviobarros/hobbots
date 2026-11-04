import { mkdtempSync, realpathSync } from "node:fs";
import type { Page } from "@playwright/test";
import { emptyDataDir, expect, type Hub, removeDataDir, startHub, test } from "./hub.ts";

let hub: Hub | undefined;
let dataDir = "";

test.beforeEach(() => {
  dataDir = emptyDataDir();
});

// Folders a test made for a hob to work in.
const extraDirs: Array<string> = [];

test.afterEach(async () => {
  await hub?.stop();
  hub = undefined;
  removeDataDir(dataDir);
  for (const dir of extraDirs.splice(0)) removeDataDir(dir);
});

interface Hob {
  readonly id: string;
  readonly instructions: string;
  readonly configVersion: number;
}

interface Message {
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly configVersion: number | null;
}

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
const hubWithPip = async (env: Record<string, string> = {}): Promise<{ current: Hub; pip: Hob }> => {
  const current = await startHub(dataDir, env);
  await api(current, "PATCH", "/api/setup", { completed: true, connectedProviders: ["claude-code"] });
  const pip = await api<Hob>(current, "POST", "/api/agents", {
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
  return { current, pip };
};

// Pip's page lists its chats; these tests have one.
const openOnlyChat = (page: Page) =>
  page
    .getByRole("main", { name: "Pip's page" })
    .getByRole("link", { name: /^Open / })
    .click();

const send = async (page: Page, content: string) => {
  const composer = page.getByRole("textbox", { name: /^Message Pip/ });
  await composer.fill(content);
  await composer.press("Enter");
  await expect(page.getByText(`Echo: ${content}`)).toBeVisible();
};

// covers AG-002
test("[TC-AG-070] editing instructions in the profile changes the next reply", async ({ page }) => {
  const { current, pip } = await hubWithPip();
  hub = current;
  await page.goto(`${current.url}/#/hobs/${pip.id}/new`);
  await send(page, "first");

  await page.getByRole("link", { name: "Edit hob" }).click();
  await expect(page.getByRole("heading", { name: "Pip", exact: true })).toBeVisible();
  const instructions = page.getByRole("textbox", { name: "What Pip should do" });
  await expect(instructions).toHaveValue("Write short answers.");
  await instructions.fill("Write long answers.");
  await expect(page.getByText("1 change not saved yet")).toBeVisible();
  // Looking at another tab keeps the unsaved edit. The arrow keys move between the tabs.
  await page.getByRole("tab", { name: "Charms" }).click();
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByRole("tab", { name: "Profile" })).toHaveAttribute("aria-selected", "true");
  await expect(instructions).toHaveValue("Write long answers.");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText(/^Saved\. Pip's next reply uses the new settings/)).toBeVisible();
  await expect(page.getByText(/· Version 2$/)).toBeVisible();

  // Back in the chat, the same thread's next reply runs on the edited configuration.
  await page.goto(`${current.url}/#/hobs/${pip.id}`);
  await openOnlyChat(page);
  await expect(page.getByText("Echo: first")).toBeVisible();
  await send(page, "second");

  const [saved] = await api<ReadonlyArray<Hob>>(current, "GET", "/api/agents");
  expect(saved).toMatchObject({ instructions: "Write long answers.", configVersion: 2 });
  const [thread] = await api<ReadonlyArray<{ id: string }>>(current, "GET", `/api/agents/${pip.id}/threads`);
  // The page shows the reply while it streams; it is stored once it completes.
  await expect
    .poll(async () => {
      const messages = await api<ReadonlyArray<Message>>(current, "GET", `/api/threads/${thread?.id}/messages`);
      return messages.filter((m) => m.role === "assistant").map((m) => [m.content, m.configVersion]);
    })
    .toEqual([
      ["Echo: first", 1],
      ["Echo: second", 2],
    ]);
});

// covers AG-002
test("[TC-AG-104] renaming a hob and changing its look in the profile shows them everywhere, past chats too", async ({
  page,
}) => {
  const { current, pip } = await hubWithPip();
  hub = current;
  await page.goto(`${current.url}/#/hobs/${pip.id}/new`);
  await send(page, "first");

  await page.getByRole("link", { name: "Edit hob" }).click();
  const profile = page.getByRole("main", { name: "Pip's profile" });
  const look = profile.getByRole("region", { name: "Name and look" });
  await look.getByRole("button", { name: "Change name or look" }).click();
  const name = look.getByRole("textbox", { name: "Name" });
  await expect(name).toHaveValue("Pip");
  await name.fill("  ");
  await expect(profile.getByText("Give the hob a name.")).toBeVisible();
  await expect(profile.getByRole("button", { name: "Save changes" })).toBeDisabled();
  await name.fill("Bramble");
  await expect(look.getByRole("radio", { name: "Look 1" })).toBeChecked();
  await look.getByRole("radio", { name: "Look 3" }).check({ force: true });
  await look.getByRole("radio", { name: "Sky" }).check({ force: true });
  await look.getByRole("radio", { name: "Tiny crown" }).click();
  await look.getByRole("radio", { name: "From the look" }).last().click();
  await profile.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText(/^Saved\. Bramble's next reply uses the new settings/)).toBeVisible();

  const renamed = page.getByRole("main", { name: "Bramble's profile" });
  await expect(renamed.getByRole("heading", { name: "Bramble", exact: true })).toBeVisible();
  const [saved] = await api<ReadonlyArray<Hob & { name: string; lookSeed: number }>>(current, "GET", "/api/agents");
  expect(saved).toMatchObject({ name: "Bramble", lookColor: "sky", hat: "crown", tool: null, configVersion: 2 });
  expect(saved?.lookSeed).not.toBe(4821);

  // The chat it had before the rename says its new name.
  await page.goto(`${current.url}/#/hobs/${pip.id}`);
  await page
    .getByRole("main", { name: "Bramble's page" })
    .getByRole("link", { name: /^Open / })
    .click();
  await expect(page.getByText("Echo: first")).toBeVisible();
  await expect(page.getByRole("main", { name: "Chat" }).getByText("Bramble", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("main", { name: "Chat" }).getByText("Pip", { exact: true })).toHaveCount(0);
});

// covers AG-006
test("[TC-AG-071] pausing, waking and retiring from the profile moves the hob to the Archive's Retired hobs", async ({
  page,
}) => {
  const { current, pip } = await hubWithPip();
  hub = current;
  await page.goto(`${current.url}/#/hobs/${pip.id}/profile`);
  await expect(page.getByRole("heading", { name: "Pip", exact: true })).toBeVisible();

  const profile = page.getByRole("main", { name: "Pip's profile" });
  const rest = profile.getByRole("region", { name: "Take a break" });
  await rest.getByRole("button", { name: "Pause Pip" }).click();
  await expect(profile.locator("header")).toContainText("Paused");
  await expect(rest).toContainText("Pip is paused. It starts nothing new until you wake it.");
  await rest.getByRole("button", { name: "Wake Pip" }).click();
  await expect(rest.getByRole("button", { name: "Pause Pip" })).toBeVisible();

  // Keeping Pip changes nothing.
  await rest.getByRole("button", { name: "Retire Pip…" }).click();
  const dialog = page.getByRole("dialog", { name: "Retire Pip?" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Keep Pip" }).click();
  await expect(dialog).toBeHidden();

  await rest.getByRole("button", { name: "Retire Pip…" }).click();
  await dialog.getByText("Stop Pip's work now").click();
  await expect(dialog.getByRole("radio", { name: /Stop Pip's work now/ })).toBeChecked();
  await dialog.getByRole("button", { name: "Retire Pip", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Pip is asleep" })).toBeVisible();

  expect(await api<ReadonlyArray<Hob>>(current, "GET", "/api/agents")).toEqual([]);
  expect(await api<ReadonlyArray<Hob>>(current, "GET", "/api/agents?status=retired")).toMatchObject([
    { id: pip.id, status: "retired" },
  ]);
  await page.getByRole("link", { name: "Open the Archive" }).click();
  await expect(page).toHaveURL(/#\/archive\?tab=hobs$/);
  await expect(
    page.getByRole("list", { name: "Retired hobs" }).getByRole("link", { name: "Read Pip's chats" }),
  ).toBeVisible();
});

// covers AG-002, UX-005
test("[TC-AG-075] changing the role in the profile updates the hob list, chat header and profile at once", async ({
  page,
}) => {
  const { current, pip } = await hubWithPip();
  hub = current;
  await page.goto(`${current.url}/#/hobs/${pip.id}/new`);
  const list = page.getByRole("navigation", { name: "Hobs and threads" });
  const header = page.getByRole("main", { name: "Chat" }).locator("header");
  await expect(list.getByRole("link", { name: /^Pip/ })).toContainText("Writer");
  await expect(header).toContainText("Writer");

  await page.getByRole("link", { name: "Edit hob" }).click();
  const profile = page.getByRole("main", { name: "Pip's profile" });
  const chip = profile.locator("header").getByText(/^(Writer|QA engineer|Bug hunter)$/);
  await expect(chip).toHaveText("Writer");
  await profile.getByRole("button", { name: "Change role" }).click();
  const sheet = page.getByRole("dialog", { name: "Pick a role" });
  // It opens on the hob's own family; QA engineer is in the software team.
  await sheet.getByRole("button", { name: /^Software team/ }).click();
  await sheet.getByText("QA engineer", { exact: true }).click();
  await expect(sheet.getByRole("radio", { name: /^QA engineer/ })).toBeChecked();
  // Escape leaves the role as it was; only Pick changes it, and the save bar still decides.
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  await expect(chip).toHaveText("Writer");
  await profile.getByRole("button", { name: "Change role" }).click();
  await sheet.getByRole("button", { name: /^Software team/ }).click();
  await sheet.getByText("QA engineer", { exact: true }).click();
  await sheet.getByRole("button", { name: "Pick QA engineer" }).click();
  await expect(sheet).toBeHidden();
  await expect(profile.getByText("QA engineer", { exact: true }).first()).toBeVisible();
  await profile.getByRole("button", { name: "Save changes" }).click();
  await expect(profile.getByText(/^Saved\. Pip's next reply uses the new settings/)).toBeVisible();
  await expect(chip).toHaveText("QA engineer");
  await page.goto(`${current.url}/#/hobs/${pip.id}`);
  await expect(list.getByRole("link", { name: /^Pip/ })).toContainText("QA engineer");
  await expect(page.getByRole("region", { name: "Pip", exact: true })).toContainText("QA engineer");
  await page.getByRole("link", { name: "New chat with Pip" }).click();
  await expect(header).toContainText("QA engineer");
  await page.getByRole("link", { name: "Edit hob" }).click();

  // A title in the user's own words keeps the QA sigil, hat and tool.
  await profile.getByRole("button", { name: "Change role" }).click();
  await sheet.getByText("Your own", { exact: true }).click();
  await sheet.getByRole("textbox", { name: "Your own role title" }).fill("Bug hunter");
  await sheet.getByRole("button", { name: "Use your own title" }).click();
  await profile.getByRole("button", { name: "Save changes" }).click();
  await expect(profile.getByText(/^Saved\. Pip's next reply uses the new settings/)).toBeVisible();
  await expect(chip).toHaveText("Bug hunter");

  await page.goto(`${current.url}/#/hobs/${pip.id}`);
  await expect(list.getByRole("link", { name: /^Pip/ })).toContainText("Bug hunter");
  await page.getByRole("link", { name: "New chat with Pip" }).click();
  await expect(header).toContainText("Bug hunter");
  const [saved] = await api<ReadonlyArray<Hob & { role: string | null; roleTitle: string; sigil: string }>>(
    current,
    "GET",
    "/api/agents",
  );
  expect(saved).toMatchObject({ role: null, roleTitle: "Bug hunter", sigil: "qa", configVersion: 3 });
});

// covers AG-002
test("[TC-AG-088] picking a voice and a length in the profile saves them as the next version", async ({ page }) => {
  const { current, pip } = await hubWithPip();
  hub = current;
  await page.goto(`${current.url}/#/hobs/${pip.id}/profile`);
  const profile = page.getByRole("main", { name: "Pip's profile" });
  const tone = profile.getByRole("region", { name: "How Pip talks" });
  await expect(tone.getByRole("radio", { name: /^Default/ })).toBeChecked();
  await expect(tone.getByRole("radio", { name: /^Balanced/ })).toBeChecked();

  // Themed voices say they change the wording only, and picking one says what stays plain.
  await expect(tone.getByRole("group", { name: /Themed/ })).toContainText("Changes wording only");
  await tone.getByText("Old wizard", { exact: true }).click();
  await expect(tone).toContainText("Code, commands, links and warnings stay plain");
  await tone.getByText("Brief", { exact: true }).click();
  await expect(page.getByText("2 changes not saved yet")).toBeVisible();
  await profile.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText(/^Saved\. Pip's next reply uses the new settings/)).toBeVisible();

  const hobs = await api<Array<Hob & { voice: string; length: string }>>(current, "GET", "/api/agents");
  const saved = hobs.find((h) => h.id === pip.id);
  expect([saved?.voice, saved?.length, saved?.configVersion]).toEqual(["wizard", "brief", 2]);
  await page.reload();
  await expect(tone.getByRole("radio", { name: /^Old wizard/ })).toBeChecked();
  await expect(tone.getByRole("radio", { name: /^Brief/ })).toBeChecked();
});

interface Permissions {
  readonly configVersion: number;
  readonly folders: ReadonlyArray<string>;
  readonly policy: {
    readonly ownFolders: ReadonlyArray<string>;
    readonly overrides: Record<string, string>;
    readonly signCommits?: boolean;
  };
  readonly decisions: Record<string, string>;
}

// covers AG-004, PE-001, PE-002
test("[TC-PE-030] the Permissions tab adds a hob's own folder and narrows a rule as new versions", async ({ page }) => {
  const { current, pip } = await hubWithPip();
  hub = current;
  // Beside the hub's data folder, not inside it: hobs never reach Hobbots' own data.
  const own = mkdtempSync(`${dataDir}-pip-`);
  extraDirs.push(own);
  await page.goto(`${current.url}/#/hobs/${pip.id}/profile`);

  // The GitHub Charm card sets each GitHub action: reads Allow, writes Ask under Balanced.
  await page.getByRole("tab", { name: "Charms" }).click();
  const card = page.getByRole("region", { name: "GitHub Charm" });
  await expect(card.getByText("Reads, pushes to, opens pull requests in and comments on")).toBeVisible();
  // No GitHub account is connected on this hub, so the Charm is not ready yet.
  await expect(card.getByText("Not ready", { exact: true })).toBeVisible();
  for (const [name, answer] of [
    ["Read code", "Allow"],
    ["Push changes", "Ask"],
    ["Open pull requests", "Ask"],
    ["Comment and reply", "Ask"],
  ] as const) {
    await expect(card.getByRole("radiogroup", { name }).getByRole("radio", { name: answer })).toBeChecked();
  }
  await page.getByRole("tab", { name: "Permissions" }).click();
  // Permissions no longer lists the GitHub actions.
  for (const name of ["Read GitHub", "Push your work", "Open pull requests", "Comment on GitHub"]) {
    await expect(page.getByRole("radiogroup", { name })).toHaveCount(0);
  }

  // An own folder is stored canonical and becomes part of Pip's folders.
  await page.getByRole("textbox", { name: "Folder path on the hub" }).fill(own);
  await page.getByRole("button", { name: "Add folder" }).click();
  const ownList = page.getByRole("list", { name: "Pip's own folders" });
  await expect(ownList.getByText(realpathSync(own))).toBeVisible();

  // Run commands is Allow under Balanced; Never is offered, a wider answer than Ask on Delete is not.
  const commands = page.getByRole("radiogroup", { name: "Run commands" });
  await expect(commands.getByRole("radio", { name: "Allow" })).toBeChecked();
  await commands.getByText("Ask", { exact: true }).click();
  await expect(commands.getByRole("radio", { name: "Ask" })).toBeChecked();
  await expect(
    page.getByRole("radiogroup", { name: "Delete files" }).getByRole("radio", { name: "Allow" }),
  ).toBeDisabled();
  await expect(page.getByRole("button", { name: "Balanced says Allow · reset" })).toBeVisible();

  const saved = await api<Permissions>(current, "GET", `/api/agents/${pip.id}/permissions`);
  expect(saved).toMatchObject({
    configVersion: 3,
    folders: [realpathSync(own)],
    policy: { ownFolders: [realpathSync(own)], overrides: { "run-commands": "ask" } },
    decisions: { "run-commands": "ask", "delete-files": "ask" },
  });

  // Picking the preset's answer again drops the override; removing the folder empties the list.
  await commands.getByText("Allow", { exact: true }).click();
  await expect(commands.getByRole("radio", { name: "Allow" })).toBeChecked();
  await ownList.getByRole("button", { name: `Remove ${realpathSync(own)}` }).click();
  await expect(page.getByText("None yet. Only Pip can work in a folder added here.")).toBeVisible();

  // Read code cannot ask, so it offers Allow and Never only. A rule set on the card is saved.
  await page.getByRole("tab", { name: "Charms" }).click();
  const read = card.getByRole("radiogroup", { name: "Read code" });
  await expect(read.getByRole("radio")).toHaveCount(2);
  await read.getByText("Never", { exact: true }).click();
  await expect(read.getByRole("radio", { name: "Never" })).toBeChecked();
  await expect
    .poll(() => api<Permissions>(current, "GET", `/api/agents/${pip.id}/permissions`))
    .toMatchObject({ decisions: { "read-github": "deny" } });
  await read.getByText("Allow", { exact: true }).click();
  await expect(read.getByRole("radio", { name: "Allow" })).toBeChecked();
  for (const name of ["Push changes", "Open pull requests", "Comment and reply"]) {
    await expect(card.getByRole("radiogroup", { name }).getByRole("radio")).toHaveCount(3);
  }
  await expect
    .poll(() => api<Permissions>(current, "GET", `/api/agents/${pip.id}/permissions`))
    .toMatchObject({ configVersion: 7, folders: [], policy: { ownFolders: [], overrides: {} } });
});

// covers AG-004, PE-005
test("[TC-PE-086] the Permissions tab turns commit signing with 1Password on, with its SSH warning, and off", async ({
  page,
}) => {
  const { current, pip } = await hubWithPip();
  hub = current;
  await page.goto(`${current.url}/#/hobs/${pip.id}/profile`);
  await page.getByRole("tab", { name: "Permissions" }).click();

  const signing = page.getByRole("switch", { name: "Sign commits with my 1Password key" });
  await expect(signing).not.toBeChecked();
  await expect(page.getByText("Pip's commits are unsigned.")).toBeVisible();
  await signing.click();
  await expect(signing).toBeChecked();
  await expect(page.getByText(/signed when your Git config asks for it/)).toBeVisible();
  await expect(page.getByText(/can also use your SSH keys to log in to servers/)).toBeVisible();
  await expect
    .poll(() => api<Permissions>(current, "GET", `/api/agents/${pip.id}/permissions`))
    .toMatchObject({ configVersion: 2, policy: { signCommits: true } });

  await page.reload();
  await page.getByRole("tab", { name: "Permissions" }).click();
  await expect(signing).toBeChecked();
  await signing.click();
  await expect(signing).not.toBeChecked();
  await expect
    .poll(async () => (await api<Permissions>(current, "GET", `/api/agents/${pip.id}/permissions`)).policy)
    .not.toHaveProperty("signCommits");
});

// covers PE-001
test("[TC-PE-031] hiding a shared folder still works after another hidden one stops being shared", async ({ page }) => {
  const { current, pip } = await hubWithPip();
  hub = current;
  const [kept, dropped] = [mkdtempSync(`${dataDir}-kept-`), mkdtempSync(`${dataDir}-dropped-`)].map((dir) => {
    extraDirs.push(dir);
    return realpathSync(dir);
  });
  await api(current, "PATCH", "/api/setup", { approvedFolders: [kept, dropped] });
  await api(current, "PATCH", `/api/agents/${pip.id}/permissions`, { hiddenSharedFolders: [dropped] });
  // Settings stops sharing the folder Pip hides; its hidden entry stays stored.
  await api(current, "PATCH", "/api/setup", { approvedFolders: [kept] });
  await page.goto(`${current.url}/#/hobs/${pip.id}/profile`);
  await page.getByRole("tab", { name: "Permissions" }).click();

  await page.getByRole("button", { name: `Hide ${kept} from Pip` }).click();
  await expect(page.getByRole("button", { name: `Show ${kept} to Pip` })).toBeVisible();
  await expect
    .poll(() => api<Permissions>(current, "GET", `/api/agents/${pip.id}/permissions`))
    .toMatchObject({ folders: [], policy: { hiddenSharedFolders: [kept] } });
  await expect(page.getByRole("alert")).toHaveCount(0);
});

// covers PE-001, PE-002
test("[TC-PE-033] an open Permissions tab follows a safety change made in another window", async ({ page }) => {
  const { current, pip } = await hubWithPip();
  hub = current;
  const shared = realpathSync(mkdtempSync(`${dataDir}-shared-`));
  extraDirs.push(shared);
  await page.goto(`${current.url}/#/hobs/${pip.id}/profile`);
  await page.getByRole("tab", { name: "Permissions" }).click();
  const commands = page.getByRole("radiogroup", { name: "Run commands" });
  await expect(commands.getByRole("radio", { name: "Allow" })).toBeChecked();

  // Another window picks Careful and shares a folder; nothing tells this hob about it.
  await api(current, "PATCH", "/api/setup", { safetyPreset: "careful", approvedFolders: [shared] });

  await expect(commands.getByRole("radio", { name: "Ask" })).toBeChecked({ timeout: 10_000 });
  await expect(commands.getByRole("radio", { name: "Allow" })).toBeDisabled();
  await expect(page.getByRole("list", { name: "Shared folders" })).toContainText(shared);
});

// covers PE-005
test("[TC-PE-043] where the sandbox cannot start, the profile and provider health say commands are blocked and why", async ({
  page,
}) => {
  const { current, pip } = await hubWithPip({ HOBBOTS_FAKE_SANDBOX: "unavailable" });
  hub = current;
  await page.goto(`${current.url}/#/hobs/${pip.id}/profile`);

  // Permissions explains why, marks each blocked rule, and lists how each rule is held.
  await page.getByRole("tab", { name: "Permissions" }).click();
  await page.getByText("Details: how these rules are kept").click();
  const held = page.getByRole("list", { name: "Enforcement on this hub" });
  await expect(held.getByRole("listitem").filter({ hasText: "Process sandbox" })).toContainText("Unsupported");
  await expect(
    page.getByText("The sandbox cannot start on this hub, so Pip's commands, local Git and the web are blocked."),
  ).toBeVisible();
  await expect(page.getByText("Why: The fake pretends the sandbox cannot start on this hub.")).toBeVisible();
  // Without the sandbox no command can push past the Push Charm, so Push is not merely checked.
  await expect(page.getByText("Checked", { exact: true })).toHaveCount(1);
  await expect(page.getByRole("switch", { name: "Run in the sandbox" })).not.toBeChecked();
  await expect(page.getByText("Blocked until the sandbox can start on this hub.")).toHaveCount(3);

  // Settings shows the same declaration under the provider.
  await page.goto(`${current.url}/#/settings/connections`);
  const claude = page.getByRole("region", { name: "Claude Code" });
  await claude.getByText("Technical details").click();
  const provider = claude.getByRole("list", { name: "Enforcement on this hub" });
  await expect(provider.getByRole("listitem").filter({ hasText: "Process sandbox" })).toContainText("Unsupported");
});

// Regression for #197: hidden radios in a scrolling panel stretched the page, so it scrolled too.
test("[TC-UX-006] a profile or settings page taller than the window scrolls only its panel", async ({ page }) => {
  const { current, pip } = await hubWithPip();
  hub = current;
  await page.setViewportSize({ width: 1200, height: 640 });
  const pageScrolls = () =>
    page.evaluate(() => document.documentElement.scrollHeight > document.documentElement.clientHeight);

  await page.goto(`${current.url}/#/hobs/${pip.id}/profile`);
  await expect(page.getByRole("heading", { name: "Pip", exact: true })).toBeVisible();
  expect(await pageScrolls()).toBe(false);

  await page.getByRole("tab", { name: "Permissions" }).click();
  await expect(page.getByRole("radiogroup", { name: "Run commands" })).toBeVisible();
  expect(await pageScrolls()).toBe(false);

  await page.goto(`${current.url}/#/settings/connections`);
  await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
  expect(await pageScrolls()).toBe(false);
});
