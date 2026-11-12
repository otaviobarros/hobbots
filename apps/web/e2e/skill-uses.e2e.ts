import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expectAccessible } from "./accessibility.ts";
import { emptyDataDir, expect, type Hub, removeDataDir, startHub, test } from "./hub.ts";

// Picking a skill in the composer and the line a reply leaves for each skill it used (ADR 029,
// Explicit use and The use line, #1096), on the fake runtime, which reports a skill it was handed.

let hub: Hub | undefined;
let dataDir = "";

test.afterEach(async () => {
  await hub?.stop();
  hub = undefined;
  removeDataDir(dataDir);
});

const skillMd = (name: string) => `---\nname: ${name}\ndescription: About ${name}.\n---\n\n# ${name}\n`;

/** A hub past setup with Pip, and each of `names` in the library for everyone, Release steps first. */
const hubWithSkill = async (names: ReadonlyArray<string> = []) => {
  dataDir = emptyDataDir();
  hub = await startHub(dataDir);
  const started = hub;
  const api = async <A>(method: string, path: string, body?: unknown): Promise<A> => {
    const response = await fetch(`${started.url}/api${path}`, {
      method,
      headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...started.headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
    return response.json() as Promise<A>;
  };
  /** Imports a skill and assigns it to everyone, or to `scope`; answers the assignment's id. */
  const addSkill = async (name: string, scope: unknown = { _tag: "Everyone" }) => {
    const imported = await api<{ imported: ReadonlyArray<{ skill: { id: string } }> }>("POST", "/skills", {
      source: { _tag: "Written", files: [{ path: "SKILL.md", text: skillMd(name) }] },
    });
    const skill = imported.imported[0]?.skill;
    if (skill === undefined) throw new Error(`${name} was not imported.`);
    return (await api<{ id: string }>("POST", `/skills/${skill.id}/assignments`, { scope })).id;
  };
  await api("PATCH", "/setup", { completed: true, connectedProviders: ["claude-code"] });
  const pip = await api<{ id: string }>("POST", "/agents", {
    name: "Pip",
    role: null,
    roleTitle: "Writer",
    sigil: "assistant",
    hat: null,
    tool: null,
    lookSeed: 1311,
    lookColor: "moss",
    runtime: "claude-code",
    model: null,
    effort: null,
    instructions: "",
  });
  const release = await addSkill("release-steps");
  for (const name of names) await addSkill(name);
  return { url: started.url, pip, api, addSkill, release };
};

const composerOf = (page: Page) => page.getByRole("textbox", { name: /^Message Pip/ });
const pickerOf = (page: Page) => page.getByRole("region", { name: "Pip's skills" });
const usedLines = (page: Page) => page.getByRole("list", { name: "Skills Pip used" });

// covers ADR 029 (Explicit use, The use line), #1096
test("[TC-UI-1096-06] Use a skill keeps the draft, the keyboard picks a skill, and the reply's Used line stays after a reload", async ({
  page,
}) => {
  const { url, pip } = await hubWithSkill();
  await page.goto(`${url}/#/hobs/${pip.id}/chat`);
  const composer = composerOf(page);
  await composer.fill("Ship it\nwith the notes");

  // Use a skill puts a `/` before what was written and leaves it there.
  await page.getByRole("button", { name: "Use a skill" }).click();
  await expect(composer).toHaveValue("/ Ship it\nwith the notes");
  await expect(pickerOf(page)).toContainText("/release-steps");
  await expectAccessible(page, pickerOf(page));

  // Escape closes the list and gives back the message as it was.
  await composer.press("Escape");
  await expect(pickerOf(page)).toBeHidden();
  await expect(composer).toHaveValue("Ship it\nwith the notes");

  // Typing filters from the cursor after the `/`, and Enter picks the highlighted skill.
  await page.getByRole("button", { name: "Use a skill" }).click();
  await page.keyboard.type("rel");
  await expect(composer).toHaveValue("/rel Ship it\nwith the notes");
  await expect(pickerOf(page).getByRole("button", { name: /release-steps/ })).toHaveAttribute("aria-current", "true");
  await page.keyboard.press("Enter");
  await expect(pickerOf(page)).toBeHidden();
  await expect(composer).toHaveValue("/release-steps Ship it\nwith the notes");

  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeHidden({ timeout: 30_000 });
  await expect(usedLines(page)).toContainText("Used Release steps (r1)");
  await expectAccessible(page, usedLines(page));

  await page.reload();
  await expect(usedLines(page)).toContainText("Used Release steps (r1)");

  // Open, beside the line, reads the skill's page, as its Activity says (#1194).
  await usedLines(page).getByRole("link", { name: "Open Release steps" }).click();
  await expect(page.getByRole("heading", { name: "Release steps", level: 2 })).toBeVisible();
});

// covers ADR 029 (Explicit use), STD-REACT-015
test("[TC-UI-1096-07] when the hob's skills cannot be read, the list says so and Try again brings them", async ({
  page,
}) => {
  const { url, pip } = await hubWithSkill();
  const hobSkills = "**/api/skills/hobs/*";
  await page.route(hobSkills, (route) => route.fulfill({ status: 500, body: "" }));
  await page.goto(`${url}/#/hobs/${pip.id}/chat`);
  const composer = composerOf(page);
  await composer.fill("/");
  // The client asks again a few times before it gives up; until then the list says it is loading.
  await expect(pickerOf(page)).toContainText("Loading Pip's skills");
  await expect(pickerOf(page).getByRole("alert")).toContainText("Hobbots could not read Pip's skills.", {
    timeout: 20_000,
  });
  await expect(pickerOf(page)).not.toContainText("has no skills");

  await page.unroute(hobSkills);
  await pickerOf(page).getByRole("button", { name: "Try again" }).click();
  await expect(pickerOf(page)).toContainText("/release-steps");
  await expect(composer).toBeFocused();
});

// covers ADR 029 (Explicit use), STD-REACT-012
test("[TC-UI-1096-10] the list follows a skill assigned or taken off while the chat is open", async ({ page }) => {
  const { url, pip, api, addSkill, release } = await hubWithSkill();
  await page.goto(`${url}/#/hobs/${pip.id}/chat`);
  const composer = composerOf(page);
  await composer.fill("/");
  await expect(pickerOf(page)).toContainText("/release-steps");

  await addSkill("review-notes");
  await expect(pickerOf(page)).toContainText("/review-notes");
  await api("DELETE", `/skills/assignments/${release}`);
  await expect(pickerOf(page)).not.toContainText("/release-steps");
  await expect(pickerOf(page)).toContainText("/review-notes");
});

// covers ADR 029 (Explicit use)
test("[TC-UI-1096-11] a long list scrolls inside its own space and keeps the highlighted skill in view", async ({
  page,
}) => {
  const names = Array.from({ length: 30 }, (_, index) => `step-${String(index).padStart(2, "0")}`);
  const { url, pip } = await hubWithSkill(names);
  await page.setViewportSize({ width: 1280, height: 640 });
  await page.goto(`${url}/#/hobs/${pip.id}/chat`);
  const composer = composerOf(page);
  await composer.fill("/");
  const picker = pickerOf(page);
  await expect(picker.getByRole("listitem")).toHaveCount(31);
  const box = await picker.boundingBox();
  expect(box?.height ?? Number.POSITIVE_INFINITY).toBeLessThan(640 / 2);
  // The composer stays on screen under it.
  await expect(composer).toBeInViewport();

  // ↑ from the first skill goes to the last, which scrolls into view.
  await composer.press("ArrowUp");
  const last = picker.getByRole("button", { name: /step-29/ });
  await expect(last).toHaveAttribute("aria-current", "true");
  await expect(last).toBeInViewport();
});

// covers ADR 029 (Explicit use), STD-UI-003
test("[TC-UI-1096-12] with the list open, Shift+Enter adds a line, Shift+Tab moves focus back, and a modified arrow moves the cursor", async ({
  page,
}) => {
  const { url, pip } = await hubWithSkill(["review-notes"]);
  await page.goto(`${url}/#/hobs/${pip.id}/chat`);
  const composer = composerOf(page);
  await composer.fill("/re");
  await expect(pickerOf(page)).toContainText("/release-steps");

  await composer.press("Shift+Enter");
  await expect(composer).toHaveValue("/re\n");
  await composer.fill("/re");
  await composer.press("Shift+ArrowDown");
  await expect(composer).toHaveValue("/re");
  // The highlight did not move: plain ↓ still goes to the second skill.
  await expect(pickerOf(page).getByRole("button", { name: /release-steps/ })).toHaveAttribute("aria-current", "true");
  await composer.press("Shift+Tab");
  await expect(composer).not.toBeFocused();
  await expect(composer).toHaveValue("/re");
});

// covers ADR 029 (Scopes, Explicit use), STD-REACT-012
test("[TC-UI-1096-13] the list follows own and shared folders another window changes", async ({ page }) => {
  const { url, pip, api, addSkill } = await hubWithSkill();
  const siteA = join(dataDir, "folders", "site-a");
  const siteB = join(dataDir, "folders", "site-b");
  mkdirSync(siteA, { recursive: true });
  mkdirSync(siteB, { recursive: true });
  // Without memory, a folder's project is its name.
  await addSkill("site-a-deploy", { _tag: "Project", identity: "site-a" });
  await addSkill("site-b-deploy", { _tag: "Project", identity: "site-b" });
  await api("PATCH", `/agents/${pip.id}/permissions`, { ownFolders: [siteA] });
  await page.goto(`${url}/#/hobs/${pip.id}/chat`);
  const composer = composerOf(page);
  await composer.fill("/site");
  await expect(pickerOf(page)).toContainText("/site-a-deploy");

  await api("PATCH", `/agents/${pip.id}/permissions`, { ownFolders: [siteB] });
  await expect(pickerOf(page)).toContainText("/site-b-deploy");
  await expect(pickerOf(page)).not.toContainText("/site-a-deploy");

  // A folder every hob shares, changed in the setup from another window, counts as the hob's too.
  await api("PATCH", "/setup", { approvedFolders: [siteA] });
  await expect(pickerOf(page)).toContainText("/site-a-deploy");
  await expect(pickerOf(page)).toContainText("/site-b-deploy");
  await api("PATCH", "/setup", { approvedFolders: [] });
  await expect(pickerOf(page)).not.toContainText("/site-a-deploy");
});
