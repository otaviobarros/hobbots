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
