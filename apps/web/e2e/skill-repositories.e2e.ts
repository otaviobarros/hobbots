import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { expectAccessible } from "./accessibility.ts";
import { emptyDataDir, expect, type Hub, removeDataDir, startHub, test } from "./hub.ts";

let hub: Hub | undefined;
let dataDir = "";

test.afterEach(async () => {
  await hub?.stop();
  hub = undefined;
  removeDataDir(dataDir);
});

const skillMd = (name: string, description: string | null) =>
  description === null
    ? `---\nname: ${name}\n---\n\n# ${name}\n`
    : `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;

const git = (folder: string, ...args: Array<string>) =>
  execFileSync("git", ["-C", folder, "-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

/**
 * An origin whose default branch holds three skills in `.claude/skills`, one of which fails the
 * checks, and the clone of it Pip works in.
 */
const repositoryOf = (root: string) => {
  const origin = join(root, "origin.git");
  const site = join(root, "site");
  mkdirSync(root, { recursive: true });
  execFileSync("git", ["init", "--quiet", "--bare", "--initial-branch=main", origin]);
  execFileSync("git", ["clone", "--quiet", `file://${origin}`, site], { stdio: "pipe" });
  git(site, "checkout", "--quiet", "-B", "main");
  const files = {
    ".claude/skills/triage/SKILL.md": skillMd("triage", "Sort support emails by urgency and product."),
    ".claude/skills/refunds/SKILL.md": skillMd("refunds", "When a customer asks for a refund."),
    ".claude/skills/old-macros/SKILL.md": skillMd("old-macros", null),
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(site, path)), { recursive: true });
    writeFileSync(join(site, path), text);
  }
  git(site, "add", "--all");
  git(site, "commit", "--quiet", "--message", "skills");
  git(site, "push", "--quiet", "origin", "main");
  return site;
};

/** A hub past setup with Pip working in a clone of a repository that holds skills of its own. */
const hubWithRepository = async () => {
  dataDir = emptyDataDir();
  hub = await startHub(dataDir);
  const started = hub;
  const site = repositoryOf(join(dataDir, "repositories"));
  const api = async (method: string, path: string, body: unknown) => {
    const response = await fetch(`${started.url}/api${path}`, {
      method,
      headers: { "content-type": "application/json", ...started.headers },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
  };
  await api("PATCH", "/setup", {
    completed: true,
    connectedProviders: ["claude-code"],
    safetyPreset: "balanced",
    approvedFolders: [site],
  });
  await api("POST", "/agents", {
    id: crypto.randomUUID(),
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
  return { url: started.url, site };
};

// covers ADR 029 (Scopes), #1098
test("[TC-UX-1098] a repository's own skills: offered once, read from the default branch, and imported for the project", async ({
  page,
}) => {
  const { url, site } = await hubWithRepository();
  await page.goto(`${url}/#/skills`);
  const main = page.getByRole("main", { name: "Skills" });
  const offer = main.getByRole("region", { name: "Found in a repository" });
  await expect(offer).toContainText("3 skills in the site repository");
  await expect(offer).toContainText(`Found in .claude/skills while Pip worked in ${site}.`);
  await expectAccessible(page, main);

  await offer.getByRole("link", { name: "See them" }).click();
  await expect(main.getByRole("link", { name: /From a project/ })).toHaveAttribute("aria-current", "page");
  await expect(main).toContainText(`Found in ${site}/.claude/skills, on its default branch at`);
  await expect(main.getByRole("checkbox", { name: "Import Triage" })).toBeChecked();
  await expect(main.getByRole("checkbox", { name: "Import Refunds" })).toBeChecked();
  // One that fails the checks says why, and cannot be picked.
  await expect(main.getByRole("checkbox", { name: "Import .claude/skills/old-macros" })).toBeDisabled();
  await expectAccessible(page, main);

  // A branch in the clone changes nothing: the default branch is what comes in.
  git(site, "checkout", "--quiet", "-b", "draft");
  writeFileSync(join(site, ".claude/skills/triage/SKILL.md"), skillMd("triage", "A draft on a branch."));
  git(site, "commit", "--quiet", "--all", "--message", "draft");

  await main.getByRole("button", { name: "Import 2 skills for the site project" }).click();
  await expect(main).toContainText("Imported Refunds and Triage for the site project. Pip uses them from its next chat.");
  await expect(main.getByRole("region", { name: "Found in a repository" })).toHaveCount(0);
  const project = main.getByRole("region", { name: "site project" });
  await expect(project).toContainText("Sort support emails by urgency and product.");
  await expect(project).not.toContainText("A draft on a branch.");
  await expectAccessible(page, main);

  // Offered once: reading the page again does not offer them again.
  await page.reload();
  await expect(main.getByRole("region", { name: "Your library" })).toContainText("Triage");
  await expect(main.getByRole("region", { name: "Found in a repository" })).toHaveCount(0);
});

// covers ADR 029 (Scopes), #1098
test("[TC-UX-1098-02] Not now closes the offer until the repository holds a new skill", async ({ page }) => {
  const { url, site } = await hubWithRepository();
  await page.goto(`${url}/#/skills`);
  const main = page.getByRole("main", { name: "Skills" });
  const offer = main.getByRole("region", { name: "Found in a repository" });
  await offer.getByRole("button", { name: "Not now" }).click();
  await expect(main).toContainText("Hobbots will not offer these again until the repository holds a skill");
  await expect(offer).toHaveCount(0);
  await page.reload();
  await expect(main.getByRole("heading", { name: "No skills yet" })).toBeVisible();
  await expect(offer).toHaveCount(0);

  // A new skill in the repository brings the offer back.
  mkdirSync(join(site, ".agents/skills/escalation"), { recursive: true });
  writeFileSync(join(site, ".agents/skills/escalation/SKILL.md"), skillMd("escalation", "When to hand a case on."));
  await page.reload();
  await expect(offer).toContainText("4 skills in the site repository");
  await expect(offer).toContainText("Found in .claude/skills and .agents/skills while Pip worked in");
  await expectAccessible(page, main);
});
