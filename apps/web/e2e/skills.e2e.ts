import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
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
