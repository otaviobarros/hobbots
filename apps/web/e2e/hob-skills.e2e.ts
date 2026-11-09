import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expectAccessible } from "./accessibility.ts";
import { emptyDataDir, expect, type Hub, removeDataDir, startHub, test } from "./hub.ts";

// #1062: a hob's skills (ADR 029): its Skills tab and the picker there, in its profile and in Summon,
// then a skill's Activity and the notes hobs leave, What changed with Roll back, and To review.

let hub: Hub | undefined;
let dataDir = "";

test.afterEach(async () => {
  await hub?.stop();
  hub = undefined;
  removeDataDir(dataDir);
});

type Imported = { imported: ReadonlyArray<{ skill: { id: string }; revision: { hash: string } }> };

const skillMd = (name: string, description: string, body: string) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;

/** A hub past setup with Pip, and two skills in the library that no hob has yet. */
const hubWithSkills = async () => {
  dataDir = emptyDataDir();
  hub = await startHub(dataDir);
  const started = hub;
  const api = async <T = { readonly id: string }>(method: string, path: string, body: unknown = {}) => {
    const response = await fetch(`${started.url}/api${path}`, {
      method,
      headers: { "content-type": "application/json", ...started.headers },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
    return response.json() as Promise<T>;
  };
  await api("PATCH", "/setup", { completed: true, connectedProviders: ["claude-code"], safetyPreset: "balanced" });
  const pip = await api("POST", "/agents", {
    id: randomUUID(),
    name: "Pip",
    role: null,
    roleTitle: "Writer",
    sigil: "assistant",
    hat: null,
    tool: null,
    lookSeed: 1301,
    lookColor: "moss",
    runtime: "claude-code",
    model: null,
    effort: null,
    instructions: "",
  });
  const skills = new Map<string, { id: string; hash: string }>();
  for (const [name, description, body] of [
    ["review-checklist", "Use when reviewing a pull request before it merges.", "Read the diff twice."],
    ["launch-email", "Use when writing a launch email for a new page.", "Subject first, then one paragraph."],
  ] as const) {
    const folder = join(dataDir, "to-import", name);
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "SKILL.md"), skillMd(name, description, body));
    const answer = await api<Imported>("POST", "/skills", { source: { _tag: "Folder", path: folder } });
    const first = answer.imported[0];
    if (first === undefined) throw new Error(`${name} was not imported.`);
    skills.set(name, { id: first.skill.id, hash: first.revision.hash });
  }
  const skill = (name: string) => {
    const found = skills.get(name);
    if (found === undefined) throw new Error(`No skill ${name}.`);
    return found;
  };
  return { url: started.url, api, pip, skill };
};

// covers ADR 029 (A hob's Skills tab, Scopes), #1062
test("[TC-UX-1062-05] a hob's Skills tab gives it a skill from the library, and its profile turns a shared one off for it alone", async ({
  page,
}) => {
  const { url, api, pip, skill } = await hubWithSkills();
  await page.goto(`${url}/#/hobs/${pip.id}?tab=skills`);
  const main = page.getByRole("main");
  const tab = main.getByRole("tabpanel", { name: /Skills/ });
  await expect(tab).toContainText("Pip carries no skills yet.");
  await expectAccessible(page, tab);

  // The picker lists the library; Give pins Pip to the revision shown.
  await tab.getByRole("button", { name: "Give Pip a skill…" }).click();
  const picker = tab.getByRole("region", { name: "Give Pip a skill from your library" });
  await expect(picker).toContainText("Not given to anyone yet");
  await expectAccessible(page, picker);
  await picker
    .getByRole("listitem")
    .filter({ hasText: "Review checklist" })
    .getByRole("button", { name: "Give to Pip" })
    .click();
  await expect(tab.getByRole("status")).toHaveText("Pip gets Review checklist from its next chat.");
  await expect(tab).toContainText("Pip carries 1 skill.");

  // Launch email given to Everyone reaches Pip, and the profile's switch turns it off for Pip alone.
  await api("POST", `/skills/${skill("launch-email").id}/assignments`, { scope: { _tag: "Everyone" } });
  await page.goto(`${url}/#/hobs/${pip.id}/profile`);
  await page.getByRole("tab", { name: "Skills" }).click();
  const profile = page.getByRole("tabpanel", { name: "Skills" });
  const shared = profile.getByRole("switch", { name: "Pip uses Launch email" });
  await expect(shared).toBeChecked();
  await expect(profile.getByRole("switch", { name: "Pip uses Review checklist" })).toHaveCount(0);
  await expectAccessible(page, profile);
  await shared.click();
  await expect(profile.getByRole("status")).toHaveText("Launch email is off for Pip from its next chat.");
  await expect(shared).not.toBeChecked();

  // Turned off, it is offered again in the picker, to turn back on.
  await profile.getByRole("button", { name: "Give Pip a skill…" }).click();
  await profile
    .getByRole("listitem")
    .filter({ hasText: "Launch email" })
    .getByRole("button", { name: "Turn on for Pip" })
    .click();
  await expect(profile.getByRole("status")).toHaveText("Pip gets Launch email again from its next chat.");
  await expect(shared).toBeChecked();
});

// covers ADR 029 (The Skills page, Pins and rollout), #1062
test("[TC-UX-1062-06] What changed lists a save with its rollout and rolls it back, and a skill's Activity shows a hob's note", async ({
  page,
}) => {
  const { url, api, pip, skill } = await hubWithSkills();
  const review = skill("review-checklist");
  await api("POST", `/skills/${review.id}/assignments`, { scope: { _tag: "Hob", agentId: pip.id } });
  await api("POST", `/skills/${review.id}/edits`, {
    base: review.hash,
    description: "Use when reviewing a pull request before it merges.",
    instructions: "Read the diff three times.",
  });

  const thread = await api("POST", `/agents/${pip.id}/threads`);
  const note = { name: "review-checklist", kind: "unclear", note: "Step 1 does not say which diff." };
  await api("POST", `/threads/${thread.id}/messages`, {
    content: `Review the change\nfake:hub skill_feedback ${JSON.stringify(note)}`,
  });

  await page.goto(`${url}/#/skills`);
  const main = page.getByRole("main", { name: "Skills" });
  await page.getByRole("navigation", { name: "Skill scopes" }).getByRole("link", { name: "What changed" }).click();
  await expect(main).toContainText("Review checklist r2, rolled out to 1 place");
  await expect(main).toContainText("Pip got Review checklist r1");
  await expectAccessible(page, main);
  await main.getByRole("button", { name: "Roll back to r1" }).click();
  await expect(main).toContainText("Review checklist is back on r1 where it moved.");
  await expect(main).toContainText("Review checklist moved from r2 to r1 for Pip");
  // The r2 row has nothing left to roll back, and the use line names the revision Pip is on (#1220).
  await expect(main.getByRole("button", { name: "Roll back to r1" })).toHaveCount(0);

  await main.getByRole("link", { name: "Review checklist" }).first().click();
  await main.getByRole("tab", { name: /Activity/ }).click();
  await expect(main).toContainText("No hob has used it yet.");
  await expect(main).toContainText("Used Review checklist (r1) under a reply that used it");
  const notes = main.getByRole("region", { name: "Notes from hobs" });
  await expect(notes).toContainText("“Step 1 does not say which diff.”", { timeout: 20_000 });
  await expect(notes).toContainText(/Pip, unclear · .* · 2 more notes suggest a revision/);
  await expectAccessible(page, main);

  // Notes that cannot be read say so, apart from the uses, and Try again reads them.
  await page.route("**/api/skills/*/feedback", (route) => route.fulfill({ status: 500, body: "{}" }));
  await page.reload();
  const failed = main.getByRole("alert").filter({ hasText: "The notes hobs left on this skill could not be read." });
  await expect(failed).toBeVisible({ timeout: 20_000 });
  await expect(main).toContainText("No hob has used it yet.");
  await page.unroute("**/api/skills/*/feedback");
  await failed.getByRole("button", { name: "Try again" }).click();
  await expect(notes).toContainText("“Step 1 does not say which diff.”");
});

// covers ADR 029 (A hob's Skills tab), #1062
test("[TC-UX-1062-07] Summon gives the hob the skills picked before it arrives", async ({ page }) => {
  const { url, api, skill } = await hubWithSkills();
  await api("POST", `/skills/${skill("review-checklist").id}/assignments`, { scope: { _tag: "Everyone" } });
  await page.goto(`${url}/#/summon?step=look`);
  await page.getByRole("textbox", { name: "Hob name" }).fill("Tinker");
  await page.getByRole("button", { name: "Next: check and summon" }).click();
  const skills = page.getByRole("region", { name: "Skills" });
  await expect(skills).toContainText("Gets Everyone's 1 skill");

  // Everyone's skill reaches it already, so only Launch email is offered.
  await skills.getByRole("button", { name: "Give it a skill…" }).click();
  const picker = skills.getByRole("region", { name: "Give Tinker a skill from your library" });
  await expect(picker.getByRole("listitem")).toHaveCount(1);
  const pick = picker
    .getByRole("listitem")
    .filter({ hasText: "Launch email" })
    .getByRole("button", { name: "Give to Tinker" });
  await pick.click();
  await expect(pick).toHaveAttribute("aria-pressed", "true");
  await expect(skills).toContainText("Also gets Launch email.");
  await expectAccessible(page, skills);

  await page.getByRole("button", { name: "Summon Tinker" }).click();
  await expect(page.getByRole("heading", { name: "Tinker is here!" })).toBeVisible();
  const hobId = /#\/hobs\/([^/]+)\/arrived/.exec(page.url())?.[1];
  await page.goto(`${url}/#/hobs/${hobId}?tab=skills`);
  await expect(page.getByRole("tabpanel", { name: /Skills/ })).toContainText("Tinker carries 2 skills.");
});

// covers ADR 029 (Proactive hobs, The Skills page), #1062
test("[TC-UX-1062-08] To review lists what a hob drafted, counted beside it, and Add decides it there", async ({
  page,
}) => {
  const { url, api, pip } = await hubWithSkills();
  const thread = await api("POST", `/agents/${pip.id}/threads`);
  const call = {
    key: "release-steps",
    name: "release-steps",
    instructions: skillMd("release-steps", "What release-steps is for, and when to use it.", "Tag the release."),
    why: "I repeat the release steps.",
  };
  await api("POST", `/threads/${thread.id}/messages`, {
    content: `Keep how we release\nfake:hub skill_propose ${JSON.stringify(call)}`,
  });

  await page.goto(`${url}/#/skills`);
  const main = page.getByRole("main", { name: "Skills" });
  const nav = page.getByRole("navigation", { name: "Skill scopes" });
  await expect(nav.getByRole("link", { name: /To review/ })).toContainText("1", { timeout: 20_000 });
  await nav.getByRole("link", { name: /To review/ }).click();
  await expect(main.getByRole("link", { name: /Pip drafted a skill: Release steps/ })).toBeVisible();
  const open = main.getByRole("article", { name: "Pip drafted a skill: Release steps" });
  await expect(open).toContainText("I repeat the release steps.");
  await expect(open.getByRole("region", { name: "The skill" })).toContainText("Tag the release.");
  await expectAccessible(page, main);

  await open.getByRole("button", { name: "Add it for Pip" }).click();
  await expect(open.getByRole("status")).toHaveText("Added Release steps r1 for Pip. Pip uses it from its next chat.");
  await expect(nav.getByRole("link", { name: /To review/ })).not.toContainText("1");
});
