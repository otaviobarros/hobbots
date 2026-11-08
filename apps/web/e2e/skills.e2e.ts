import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expectAccessible } from "./accessibility.ts";
import { emptyDataDir, expect, type Hub, removeDataDir, startHub, test } from "./hub.ts";

let hub: Hub | undefined;
let dataDir = "";

test.afterEach(async () => {
  await hub?.stop();
  hub = undefined;
  removeDataDir(dataDir);
});

/** A hub past setup with two hobs, Pip and Wren, and a skill folder on its computer to import. */
const hubWithHobs = async () => {
  dataDir = emptyDataDir();
  hub = await startHub(dataDir);
  const started = hub;
  const api = async (method: string, path: string, body: unknown) => {
    const response = await fetch(`${started.url}/api${path}`, {
      method,
      headers: { "content-type": "application/json", ...started.headers },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
    return response.json() as Promise<{ readonly id: string }>;
  };
  await api("PATCH", "/setup", { completed: true, connectedProviders: ["claude-code"] });
  for (const [name, lookSeed] of [
    ["Pip", 1301],
    ["Wren", 1302],
  ] as const) {
    await api("POST", "/agents", {
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
  }
  const folder = join(dataDir, "to-import", "review-checklist");
  mkdirSync(folder, { recursive: true });
  writeFileSync(
    join(folder, "SKILL.md"),
    "---\nname: review-checklist\ndescription: Use when reviewing a pull request before it merges.\n---\n\nRead the diff twice.\n",
  );
  return { url: started.url, folder, api };
};

// covers ADR 029 (the Skills page, editing and rollout), #1062
test("[TC-UX-1062] Skills: write one, give it out, edit and roll out with one hob held back, roll back, and import a folder", async ({
  page,
}) => {
  const { url, folder } = await hubWithHobs();
  await page.goto(`${url}/#/`);
  await page.getByRole("link", { name: "Skills", exact: true }).first().click();
  const main = page.getByRole("main", { name: "Skills" });
  await expect(main.getByRole("heading", { name: "No skills yet" })).toBeVisible();
  await expectAccessible(page, main);

  // Write one, checked as you type, and give it to Pip.
  await main.getByRole("link", { name: "Write one" }).click();
  await main.getByLabel("Name").fill("Release steps");
  await expect(main).toContainText("Typed as release-steps");
  await main.getByLabel("When to use it").fill("Short.");
  await expect(main).toContainText("Too short to pick well");
  await main.getByLabel("When to use it").fill("Use when releasing the site: version, changelog and tag.");
  await expect(main).toContainText("Good: it says when to use it.");
  await main.getByLabel("Instructions").fill("Bump the version.\nTag the release.");
  await main.getByRole("radio", { name: /Pip/ }).check();
  await expectAccessible(page, main);
  await main.getByRole("button", { name: "Add to the library" }).click();
  await expect(main.getByRole("heading", { name: "Release steps", level: 2 })).toBeVisible();
  await expect(main).toContainText("Added Release steps as r1. Pip gets it from the next chat.");
  await expect(main).toContainText("Tag the release.");

  // Also give it to Wren, then keep Wren on r1.
  const aside = page.getByRole("complementary", { name: "About this skill" });
  await aside.getByRole("button", { name: "Also give it to…" }).click();
  await aside.getByRole("button", { name: /Wren/ }).click();
  await expect(main).toContainText("Wren gets r1 from its next chat.");
  await main.getByRole("tab", { name: /Who uses it/ }).click();
  const wren = main.getByRole("listitem").filter({ hasText: "Wren" });
  await wren.getByRole("button", { name: "Keep on r1" }).click();
  await expect(main).toContainText("Wren stays on r1 when you save a new revision.");
  await expectAccessible(page, main);

  // Edit: the rollout says who moves, and saving moves Pip only.
  await aside.getByRole("link", { name: "Edit" }).click();
  await expect(main.getByRole("heading", { name: "Edit Release steps" })).toBeVisible();
  await main.getByLabel("Instructions").fill("Bump the version.\nWrite the changelog.\nTag the release.");
  await expect(main.getByRole("region", { name: "Rolls out to 1 place when you save" })).toBeVisible();
  await expectAccessible(page, main);
  await main.getByRole("button", { name: "Save and roll out to 1 place" }).click();
  await expect(main).toContainText("Saved r2 and rolled it out to 1 place from their next chat.");
  await expect(main).toContainText("Write the changelog.");
  await main.getByRole("tab", { name: /Who uses it/ }).click();
  await expect(main.getByRole("listitem").filter({ hasText: "Wren" })).toContainText("Kept on r1");

  // History shows what r2 changed, and rolls back to r1.
  await main.getByRole("tab", { name: /History/ }).click();
  await main.getByRole("link", { name: "Changes" }).click();
  await expect(main.getByRole("region", { name: "What r2 changed against r1" })).toContainText("Write the changelog.");
  await expectAccessible(page, main);
  await main.getByRole("button", { name: "Roll back to r1" }).click();
  await expect(main).toContainText("Rolled back to r1: 1 place moves to it from the next chat.");

  // Import a folder on the hub's computer, and give it to Everyone.
  await page.getByRole("link", { name: "Add a skill" }).click();
  await main.getByRole("link", { name: /Folder or \.zip/ }).click();
  await main.getByLabel("Folder on the hub's computer").fill(folder);
  await main.getByRole("button", { name: "Look" }).click();
  await expect(main).toContainText("Found 1 skill.");
  await main.getByRole("radio", { name: /Everyone/ }).check();
  await expectAccessible(page, main);
  await main.getByRole("button", { name: "Import 1 skill" }).click();
  await expect(main).toContainText("Imported 1 skill as r1. Everyone gets it from the next chat.");
  await expect(main.getByRole("link", { name: /Review checklist/ }).first()).toBeVisible();
  await expectAccessible(page, main);
});

// covers ADR 029 (Editing), #1062
test("[TC-UX-1062-02] a save from another device while you edit keeps your text and says it cannot be saved over", async ({
  page,
}) => {
  const { url, folder, api } = await hubWithHobs();
  const imported = (await api("POST", "/skills", { source: { _tag: "Folder", path: folder } })) as unknown as {
    imported: ReadonlyArray<{ skill: { id: string }; revision: { hash: string } }>;
  };
  const first = imported.imported[0];
  if (first === undefined) throw new Error("Nothing was imported.");
  const { skill, revision } = first;
  await page.goto(`${url}/#/skills?skill=${skill.id}&edit=skill`);
  const main = page.getByRole("main", { name: "Skills" });
  await expect(main.getByRole("heading", { name: "Edit Review checklist" })).toBeVisible();
  await main.getByLabel("Instructions").fill("My draft, not saved yet.");

  // Another device saves r2 from r1: the page reads it, and the draft and its base stay.
  await api("POST", `/skills/${skill.id}/edits`, {
    base: revision.hash,
    description: "Use when reviewing a pull request before it merges.",
    instructions: "Saved elsewhere.",
  });
  await expect(main.getByRole("status").filter({ hasText: "r2 was saved while you edited r1" })).toBeVisible();
  await expect(main.getByLabel("Instructions")).toHaveValue("My draft, not saved yet.");
  await expect(main.getByRole("button", { name: /Save/ })).toBeDisabled();
  await expectAccessible(page, main);
});

// covers ADR 029 (Editing), #1062
test("[TC-UX-1062-03] a save whose answer is lost is finished from the editor, not read as someone else's", async ({
  page,
}) => {
  const { url, folder, api } = await hubWithHobs();
  const imported = (await api("POST", "/skills", { source: { _tag: "Folder", path: folder } })) as unknown as {
    imported: ReadonlyArray<{ skill: { id: string } }>;
  };
  const first = imported.imported[0];
  if (first === undefined) throw new Error("Nothing was imported.");
  await page.goto(`${url}/#/skills?skill=${first.skill.id}&edit=skill`);
  const main = page.getByRole("main", { name: "Skills" });
  await main.getByLabel("Instructions").fill("Read the diff three times.");

  // The hub saves r2, and its answer never reaches the page.
  let lose = true;
  await page.route("**/api/skills/*/edits", async (route) => {
    if (!lose) return route.continue();
    lose = false;
    await route.fetch();
    await route.abort("connectionreset");
  });
  await main.getByRole("button", { name: /Save/ }).click();
  await expect(main.getByRole("status").filter({ hasText: "your save may have reached the hub" })).toBeVisible();
  await expect(main.getByLabel("Instructions")).toHaveValue("Read the diff three times.");
  await expectAccessible(page, main);

  // Finish saving sends it again as it was: the hub answers with r2, its own save.
  await main.getByRole("button", { name: "Finish saving" }).click();
  await expect(main.getByRole("heading", { name: "Review checklist", level: 2 })).toBeVisible();
  await expect(main).toContainText("Read the diff three times.");
});

// covers ADR 029 (Editing), #1062
test("[TC-UX-1062-04] rollout switches alone, or with text that saves the same, save nothing, and text that is an older revision again moves no place", async ({
  page,
}) => {
  const { url, folder, api } = await hubWithHobs();
  const imported = (await api("POST", "/skills", { source: { _tag: "Folder", path: folder } })) as unknown as {
    imported: ReadonlyArray<{ skill: { id: string }; revision: { hash: string } }>;
  };
  const first = imported.imported[0];
  if (first === undefined) throw new Error("Nothing was imported.");
  const { skill } = first;
  await api("POST", `/skills/${skill.id}/assignments`, { scope: { _tag: "Everyone" } });
  const description = "Use when reviewing a pull request before it merges.";
  const edit = async (base: string, instructions: string) =>
    (await api("POST", `/skills/${skill.id}/edits`, { base, description, instructions })) as unknown as {
      revision: { hash: string };
    };
  const r2 = await edit(first.revision.hash, "Read the diff once.");
  await edit(r2.revision.hash, "Read the diff twice, then the tests.");

  // Only a switch changed: Save stays off, and says where holding a place back is done.
  await page.goto(`${url}/#/skills?skill=${skill.id}&edit=skill`);
  const main = page.getByRole("main", { name: "Skills" });
  await expect(main.getByRole("heading", { name: "Edit Review checklist" })).toBeVisible();
  await main.getByRole("switch", { name: "Everyone moves to r4" }).click();
  await expect(main.getByRole("button", { name: /Save/ })).toBeDisabled();
  await expect(main).toContainText("Nothing to save yet");
  // Without its final line break, the text still saves as r3, so it is still nothing to save.
  await expect(main.getByLabel("Instructions")).toHaveValue("Read the diff twice, then the tests.\n");
  await main.getByLabel("Instructions").fill("Read the diff twice, then the tests.");
  await expect(main.getByRole("button", { name: /Save/ })).toBeDisabled();
  await expect(main).toContainText("Nothing to save yet");
  await expectAccessible(page, main);

  // The text of r2 again is r2: nothing is saved, Everyone stays on r3, and the page says how to go back.
  await main.getByRole("switch", { name: "Everyone moves to r4" }).click();
  await main.getByLabel("Instructions").fill("Read the diff once.");
  await main.getByRole("button", { name: /Save/ }).click();
  await expect(main.getByRole("alert")).toContainText("That is r2 again, so nothing was saved and no place moved.");
  await expect(main.getByLabel("Instructions")).toHaveValue("Read the diff once.");
  await main.getByRole("link", { name: "Cancel" }).click();
  await main.getByRole("tab", { name: /Who uses it/ }).click();
  await expect(main.getByRole("listitem").filter({ hasText: "Everyone" })).toContainText("r3");
});

// covers ADR 029 (Backups, exports and Diagnostics), #1064
test("[TC-UX-1064] Skills: export a set with skills.lock.json, import it on a fresh hub, and see it in Diagnostics", async ({
  page,
}) => {
  const { api } = await hubWithHobs();
  const imported = (await api("POST", "/skills", {
    source: {
      _tag: "Written",
      files: [
        {
          path: "SKILL.md",
          text: "---\nname: release-steps\ndescription: Use when releasing the site, from version to tag.\n---\n\nTag the release.\n",
        },
      ],
    },
  })) as unknown as { imported: ReadonlyArray<{ skill: { id: string } }> };
  const skillId = imported.imported[0]?.skill.id ?? "";
  const pip = (
    (await (await fetch(`${hub?.url}/api/agents`, { headers: hub?.headers ?? {} })).json()) as Array<{
      id: string;
      name: string;
    }>
  ).find((agent) => agent.name === "Pip");
  await api("POST", `/skills/${skillId}/assignments`, { scope: { _tag: "Hob", agentId: pip?.id } });
  await api("POST", `/skills/${skillId}/assignments`, { scope: { _tag: "Everyone" } });
  // The hub saves exports in its user's Downloads folder; this hub's user lives in a folder of its own.
  await hub?.stop();
  const home = emptyDataDir();
  mkdirSync(join(home, "Downloads"), { recursive: true });
  hub = await startHub(dataDir, { HOME: home });

  await page.goto(`${hub.url}/#/skills`);
  const main = page.getByRole("main", { name: "Skills" });
  await main.getByRole("link", { name: "Export…" }).click();
  await expect(main.getByRole("heading", { name: "Export skills" })).toBeVisible();
  await expect(main.getByRole("checkbox", { name: "Export Release steps" })).toBeChecked();
  await expect(main.getByRole("switch", { name: "Include who gets each skill" })).toBeChecked();
  await expectAccessible(page, main);
  await main.getByRole("button", { name: "Export 1 skill" }).click();
  await expect(main).toContainText(
    /Saved hobbots-skills-\d{4}-\d{2}-\d{2} to Downloads: 1 skill and skills\.lock\.json\./,
  );
  const [exported] = readdirSync(join(home, "Downloads"));
  const folder = join(home, "Downloads", exported ?? "");

  // A fresh hub, where Pip is a new hob of the same name, takes the export as it was.
  await hub.stop();
  removeDataDir(dataDir);
  // It answers at the same address, so the browser's device on the first hub goes first.
  await page.context().clearCookies();
  const fresh = await hubWithHobs();
  try {
    await page.goto(`${fresh.url}/#/skills?add=file`);
    await main.getByLabel("Folder on the hub's computer").fill(folder);
    await main.getByRole("button", { name: "Look" }).click();
    await expect(main).toContainText("A Hobbots export from");
    await expect(main).toContainText("Exactly the exported revision");
    await expectAccessible(page, main);
    await main.getByRole("button", { name: "Import 1 skill" }).click();
    await expect(main).toContainText(
      "Imported 1 skill with the revisions the export names, and gave out 2 assignments.",
    );

    // Diagnostics names each hob's skills and revisions, never their instructions.
    await page.goto(`${fresh.url}/#/settings/help`);
    await page.getByText("Technical details").click();
    const diagnostics = page.getByRole("region", { name: "Diagnostics" });
    const skills = diagnostics.getByRole("list", { name: "Skills each hob has" });
    await expect(skills.getByRole("listitem").filter({ hasText: "Pip" })).toContainText("Release steps r1");
    await expect(skills.getByRole("listitem").filter({ hasText: "Wren" })).toContainText("Release steps r1");
    await expect(diagnostics).not.toContainText("Tag the release.");
  } finally {
    removeDataDir(home);
  }
});

test("[TC-UX-1139] a skill from ~/.agents/skills is read-only with Make a copy, and Export leaves it out", async ({
  page,
}) => {
  await hubWithHobs();
  // The hub reads a ~/.agents/skills of its own, with one skill in it.
  await hub?.stop();
  const agents = join(dataDir, "agents-skills");
  mkdirSync(join(agents, "pdf-forms"), { recursive: true });
  writeFileSync(
    join(agents, "pdf-forms", "SKILL.md"),
    "---\nname: pdf-forms\ndescription: Use when filling in or reading a PDF form.\n---\n\nList the fields first.\n",
  );
  const home = emptyDataDir();
  mkdirSync(join(home, "Downloads"), { recursive: true });
  hub = await startHub(dataDir, { HOME: home, HOBBOTS_AGENTS_SKILLS: agents });
  // The page names the folder HOBBOTS_AGENTS_SKILLS set, not ~/.agents/skills (#1220).
  const shown = agents.replace(/^\/(?:Users|home)\/[^/]+/, "~");
  try {
    await page.goto(`${hub.url}/#/skills`);
    const main = page.getByRole("main", { name: "Skills" });
    await main
      .getByRole("link", { name: /Pdf forms/ })
      .first()
      .click();
    await expect(main.getByRole("heading", { name: "Pdf forms", level: 2 })).toBeVisible();
    await expect(main.getByRole("note")).toContainText(`${shown}/pdf-forms`);
    await expect(main.getByText(`From ${shown}`, { exact: true })).toBeVisible();
    const aside = main.getByRole("complementary", { name: "About this skill" });
    await expect(aside.getByRole("link", { name: "Edit" })).toHaveCount(0);
    await expect(aside.getByRole("button", { name: "Remove from the library…" })).toHaveCount(0);
    await expect(aside).toContainText("Not in backups or exports.");

    await aside.getByRole("button", { name: "Make a copy…" }).click();
    const form = aside.getByRole("form", { name: "Make a copy of Pdf forms" });
    await expect(form.getByRole("textbox", { name: "Typed as" })).toHaveValue("pdf-forms-copy");
    await expect(form.getByRole("radio", { name: "Nobody yet" })).toBeChecked();
    await expectAccessible(page, main);
    await form.getByRole("button", { name: "Make the copy" }).click();
    await expect(main).toContainText(
      `Pdf forms copy is in your library at r1, and you can edit it. The original in ${shown} is unchanged.`,
    );
    // The copy is yours to edit.
    await expect(main.getByRole("heading", { name: "Pdf forms copy", level: 2 })).toBeVisible();
    await expect(
      main.getByRole("complementary", { name: "About this skill" }).getByRole("link", { name: "Edit" }),
    ).toBeVisible();

    // Export lists the copy and leaves the original out, saying why.
    await page.goto(`${hub.url}/#/skills`);
    await main.getByRole("link", { name: "Export…" }).click();
    await expect(main.getByRole("checkbox", { name: /Export Pdf forms copy/ })).toBeChecked();
    await expect(main.getByRole("checkbox", { name: "Export Pdf forms", exact: true })).toHaveCount(0);
    const left = main.getByRole("region", { name: "Not exported" });
    await expect(left).toContainText("Pdf forms");
    await expect(left).toContainText(
      `Skills in ${shown} stay in that folder. Another computer's Hobbots reads its own.`,
    );
    await expect(left).toContainText(`Everyone · ${shown}`);
    await expectAccessible(page, main);
  } finally {
    removeDataDir(home);
  }
});

// covers ADR 029 (Skill sets), #1143
test("[TC-UX-1143] a plugin comes in as one set, opens on its own page, and a skill of it opens read-only with Make a copy", async ({
  page,
}) => {
  const { url } = await hubWithHobs();
  // A plugin whose two skills share a file of rules, as agent-engineering's do.
  const plugin = join(dataDir, "to-import", "agent-engineering");
  mkdirSync(join(plugin, ".claude-plugin"), { recursive: true });
  writeFileSync(
    join(plugin, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "agent-engineering", version: "0.5.0", description: "A playbook for coding agents." }),
  );
  for (const [name, description] of [
    ["deliver-change", "Use to run the whole flow, from plan to draft pull request."],
    ["plan-change", "Use to plan a change: acceptance criteria, scope, slices and checks."],
  ] as const) {
    mkdirSync(join(plugin, "skills", name), { recursive: true });
    writeFileSync(
      join(plugin, "skills", name, "SKILL.md"),
      `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\nFirst read the [contract](../../references/workflow-contract.md).\n`,
    );
  }
  mkdirSync(join(plugin, "references"), { recursive: true });
  writeFileSync(join(plugin, "references", "workflow-contract.md"), "# Shared workflow contract\n");

  await page.goto(`${url}/#/skills?add=file`);
  const main = page.getByRole("main", { name: "Skills" });
  await main.getByLabel("Folder on the hub's computer").fill(plugin);
  await main.getByRole("button", { name: "Look" }).click();
  await expect(main).toContainText("This source is a plugin whose skills share files, so it comes in as one set");
  const candidate = main.getByRole("listitem", { name: "The set agent-engineering" });
  await expect(candidate).toContainText("Set of 2 skills");
  await expect(candidate.getByRole("list", { name: "The skills in agent-engineering" })).toContainText(
    "/deliver-change",
  );
  await expect(candidate).toContainText("Shared by them: references/, 1 file.");
  await expect(main.getByRole("group", { name: "Give the set to" })).toBeVisible();
  await main.getByRole("radio", { name: /Everyone/ }).check();
  await expectAccessible(page, main);
  await main.getByRole("button", { name: "Add agent-engineering, 2 skills" }).click();

  // The set's page: its skills, the file they share, and no editor.
  await expect(main).toContainText("Added agent-engineering. Everyone gets its 2 skills from the next chat.");
  await expect(main.getByRole("heading", { name: "agent-engineering", level: 2 })).toBeVisible();
  await expect(main.getByRole("note")).toContainText("These skills come and update together");
  const skills = main.getByRole("list", { name: "Skills in this set" });
  await expect(skills.getByRole("link")).toHaveCount(2);
  await expect(main.getByRole("region", { name: "Shared files" })).toContainText("references/workflow-contract.md");
  await expect(main.getByRole("region", { name: "Shared files" })).toContainText("linked by all 2");
  const aside = main.getByRole("complementary", { name: "About this set" });
  await expect(aside.getByRole("link", { name: "Edit" })).toHaveCount(0);
  await expect(aside.getByRole("button", { name: "Remove the set…" })).toBeVisible();
  await expectAccessible(page, main);

  // The library lists it as one row.
  await page.goto(`${url}/#/skills`);
  const row = main.getByRole("link", { name: /agent-engineering/ }).first();
  await expect(row).toContainText("Set of 2 skills");
  await row.click();

  // A skill of the set opens read-only, and Make a copy makes a loose skill you can edit.
  await skills.getByRole("link", { name: /^deliver-change/ }).click();
  await expect(main.getByRole("heading", { name: "Deliver change", level: 2 })).toBeVisible();
  await expect(main.getByRole("note")).toContainText("changes only with a new version of the set");
  await expect(main).toContainText("First read the contract.");
  const memberAside = main.getByRole("complementary", { name: "About this skill" });
  await expect(memberAside.getByRole("link", { name: "Edit" })).toHaveCount(0);
  await expectAccessible(page, main);
  await memberAside.getByRole("button", { name: "Make a copy…" }).click();
  const form = memberAside.getByRole("form", { name: "Make a copy of Deliver change" });
  await expect(form.getByRole("textbox", { name: "Typed as" })).toHaveValue("deliver-change-copy");
  await form.getByRole("button", { name: "Make the copy" }).click();
  await expect(main).toContainText(
    "Deliver change copy is in your library at r1, and you can edit it. agent-engineering is unchanged.",
  );
  await expect(
    main.getByRole("complementary", { name: "About this skill" }).getByRole("link", { name: "Edit" }),
  ).toBeVisible();
  // It brought the file it links to.
  await expect(main).toContainText("linked/references/workflow-contract.md");
  await expectAccessible(page, main);
});

// covers ADR 029 (Try in a chat, Health checks), #1099
test("[TC-UX-1099] the Overview shows every finding and what each hob carries, and Try in a chat opens a chat with only the draft and leads back to it", async ({
  page,
}) => {
  const { url, folder, api } = await hubWithHobs();
  const vague = join(dataDir, "to-import", "tidy-up");
  mkdirSync(vague, { recursive: true });
  writeFileSync(join(vague, "SKILL.md"), "---\nname: tidy-up\ndescription: Tidies things.\n---\n\nTidy it.\n");
  const added = async (path: string) => {
    const imported = (await api("POST", "/skills", { source: { _tag: "Folder", path } })) as unknown as {
      readonly imported: ReadonlyArray<{ readonly skill: { readonly id: string } }>;
    };
    const skill = imported.imported[0]?.skill;
    if (skill === undefined) throw new Error(`Nothing imported from ${path}`);
    await api("POST", `/skills/${skill.id}/assignments`, { scope: { _tag: "Everyone" }, held: false });
  };
  await added(folder);
  await added(vague);
  // Eight more whose descriptions say nothing of when to use them, so the card lists more than it shows at first.
  for (let n = 1; n <= 8; n += 1) {
    const one = join(dataDir, "to-import", `chore-${n}`);
    mkdirSync(one, { recursive: true });
    writeFileSync(join(one, "SKILL.md"), `---\nname: chore-${n}\ndescription: Chores.\n---\n\nDo it.\n`);
    await api("POST", "/skills", { source: { _tag: "Folder", path: one } });
  }

  await page.goto(`${url}/#/`);
  await page.getByRole("link", { name: "Skills", exact: true }).first().click();
  const main = page.getByRole("main", { name: "Skills" });
  const worth = main.getByRole("region", { name: "Worth a look" });
  const findings = worth.getByRole("link", { name: /description may not trigger/ });
  await expect(findings).toHaveCount(8);
  await worth.getByRole("button", { name: "Show 1 more" }).click();
  await expect(findings).toHaveCount(9);
  await expect(worth).toContainText("Tidy up's description may not trigger");
  const carries = main.getByRole("region", { name: "What each hob carries" });
  await expect(carries).toContainText("Pip");
  await expect(carries).toContainText("Wren");
  await expectAccessible(page, main);

  // A line opens where you act on it: the skill, to edit its description, and from there Try in a chat.
  await worth.getByRole("link", { name: /Tidy up's description may not trigger/ }).click();
  await expect(main.getByRole("heading", { name: "Tidy up", level: 2 })).toBeVisible();
  const aside = page.getByRole("complementary", { name: "About this skill" });
  await aside.getByRole("link", { name: "Edit" }).click();
  await main.getByLabel("When to use it").fill("Use when a folder needs tidying before a release.");
  // Reading the draft back fails on the way until `failing` is turned off: never taken as gone.
  let failing = true;
  await page.route("**/api/skill-trials/*", (route) =>
    failing && route.request().method() === "GET" ? route.fulfill({ status: 500, body: "{}" }) : route.fallback(),
  );
  await main.getByRole("button", { name: "Try in a chat" }).click();
  await page.getByRole("menuitem", { name: /Wren/ }).click();

  await expect(page).toHaveURL(/\/threads\//);
  const notice = page.getByRole("region", { name: "Trying the draft of Tidy up." });
  await expect(notice).toContainText("nothing here reaches the library");
  await expect(notice.getByRole("link", { name: "Back to the draft" })).toBeVisible();
  await expectAccessible(page, page.getByRole("main"));
  // Back to the draft opens the editor on the text you tried, so you save what you tested. A read that
  // fails on the way says so with Try again, and never opens the editor without your text.
  await notice.getByRole("link", { name: "Back to the draft" }).click();
  await expect(main.getByRole("alert")).toContainText("Hobbots could not open the draft you tried.");
  await expect(main.getByLabel("When to use it")).toHaveCount(0);
  failing = false;
  await main.getByRole("button", { name: "Try again" }).click();
  await expect(main.getByRole("heading", { name: "Edit Tidy up" })).toBeVisible();
  await expect(main.getByLabel("When to use it")).toHaveValue("Use when a folder needs tidying before a release.");
  await main.getByRole("button", { name: "Save and roll out to 1 place" }).click();
  await expect(main).toContainText("Saved r2 and rolled it out to 1 place from their next chat.");
  await expect(main).toContainText("Use when a folder needs tidying before a release.");
});
