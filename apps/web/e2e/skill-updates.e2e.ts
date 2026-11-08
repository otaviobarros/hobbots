import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
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

const skillMd = (steps: string) =>
  `---\nname: release\ndescription: Use when releasing the site, from version to tag.\n---\n\n${steps}\n`;

/** A Git repository on the hub's computer holding one skill, and a way to commit a change to it. */
const upstreamOf = (root: string) => {
  mkdirSync(root, { recursive: true });
  const git = (...args: Array<string>) =>
    execFileSync("git", ["-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
      encoding: "utf8",
    }).trim();
  const commit = (files: Record<string, string>, executable: ReadonlyArray<string> = []) => {
    for (const [path, text] of Object.entries(files)) {
      const target = join(root, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, text);
      if (executable.includes(path)) chmodSync(target, 0o755);
    }
    git("add", "--all");
    git("commit", "--quiet", "--message", "change");
  };
  git("init", "--quiet", "--initial-branch=main");
  commit({ "SKILL.md": skillMd("Bump the version.") });
  return { url: `file://${root}`, commit };
};

/** A hub past setup with Pip, and `release` imported from a Git repository and given to Pip. */
const hubWithGitSkill = async () => {
  dataDir = emptyDataDir();
  hub = await startHub(dataDir);
  const started = hub;
  const api = async <A>(method: string, path: string, body: unknown): Promise<A> => {
    const response = await fetch(`${started.url}/api${path}`, {
      method,
      headers: { "content-type": "application/json", ...started.headers },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
    return response.json() as Promise<A>;
  };
  await api("PATCH", "/setup", { completed: true, connectedProviders: ["claude-code"] });
  const pip = await api<{ readonly id: string }>("POST", "/agents", {
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
  const upstream = upstreamOf(join(dataDir, "upstream", "release"));
  const imported = await api<{ imported: ReadonlyArray<{ skill: { id: string } }> }>("POST", "/skills", {
    source: { _tag: "Git", url: upstream.url, ref: "main" },
  });
  const skillId = imported.imported[0]?.skill.id;
  if (skillId === undefined) throw new Error("Nothing was imported.");
  await api("POST", `/skills/${skillId}/assignments`, { scope: { _tag: "Hob", agentId: pip.id } });
  return { url: started.url, upstream, skillId };
};

// covers ADR 029 (Updates from a source), #1097
test("[TC-UX-1097] Skills › Updates: check, review the diff, update, update automatically with Roll back, and a script that waits", async ({
  page,
}) => {
  const { url, upstream, skillId } = await hubWithGitSkill();
  await page.goto(`${url}/#/skills?view=updates`);
  const main = page.getByRole("main", { name: "Skills" });
  await expect(main).toContainText("Every skill is up to date");
  await expectAccessible(page, main);

  // A new upstream commit: Check for updates finds it, and nothing changes until you update.
  upstream.commit({ "SKILL.md": skillMd("Bump the version.\nWrite the changelog.") });
  await page.getByRole("button", { name: "Check for updates" }).click();
  await expect(main).toContainText("Checked 1 skill from Git. 1 update waits for you.");
  await expect(page.getByRole("link", { name: /^Updates\s*1$/ })).toBeVisible();
  const review = main.getByRole("article", { name: "Release" });
  await expect(review.getByRole("region", { name: "SKILL.md" })).toContainText("Write the changelog.");
  await expect(review).toContainText("No other files changed");
  await expect(main.getByRole("list", { name: "Updates that wait for you" })).toContainText("Clean");
  await expectAccessible(page, main);
  await review.getByRole("button", { name: "Update and roll out to 1 hob" }).click();
  await expect(main).toContainText(
    "Release r2 is in your library and rolls out from each hob's next chat. r1 stays in the history.",
  );
  await expect(main).toContainText("Every skill is up to date");

  // Update automatically, from the skill's page: a clean update rolls out by itself, with Roll back.
  await page.goto(`${url}/#/skills?skill=${skillId}`);
  const aside = page.getByRole("complementary", { name: "About this skill" });
  await aside.getByRole("switch", { name: "Update automatically" }).click();
  await expect(aside).toContainText("Updates automatically from");
  await expectAccessible(page, main);
  upstream.commit({ "SKILL.md": skillMd("Bump the version.\nWrite the changelog.\nTag the release.") });
  await page.getByRole("button", { name: "Check for updates" }).click();
  await expect(main).toContainText("1 skill updated automatically.");
  await page.goto(`${url}/#/skills?view=changes`);
  const automatic = main.getByRole("listitem").filter({ hasText: "Updated automatically" }).first();
  await expect(automatic).toBeVisible();
  await expectAccessible(page, main);
  await automatic.getByRole("button", { name: /Roll back/ }).click();
  await expect(main).toContainText("Release is back on r2 where it moved.");

  // One that adds a script waits for you, flagged, even with Update automatically on.
  upstream.commit({ "SKILL.md": skillMd("Run scripts/check.sh first."), "scripts/check.sh": "#!/bin/sh\necho ok\n" }, [
    "scripts/check.sh",
  ]);
  await page.goto(`${url}/#/skills?view=updates`);
  await page.getByRole("button", { name: "Check for updates" }).click();
  await expect(main).toContainText("Checked 1 skill from Git. 1 update waits for you.");
  const flagged = main.getByRole("article", { name: "Release" });
  await expect(flagged.getByRole("region", { name: "Worth a careful look" })).toContainText("scripts/check.sh");
  await expect(flagged).toContainText("It waits for you even with Update automatically on.");
  await expect(flagged.getByRole("region", { name: "Other files" })).toContainText("scripts/check.shNew script");
  await expectAccessible(page, main);

  // The repository moves on after the check: Update is refused, and adds nothing.
  upstream.commit({ "notes.md": "Moved on." });
  await flagged.getByRole("button", { name: /^Update/ }).click();
  await expect(main).toContainText("The repository changed since this check.");
  await expectAccessible(page, main);

  // Not now: it leaves Updates until the source changes again.
  await flagged.getByRole("button", { name: "Not now" }).click();
  await expect(main).toContainText("Hobbots shows the next upstream change.");
  await expect(main).toContainText("Every skill is up to date");
});

// covers ADR 029 (Updates from a source), #1097
test("[TC-UX-1097-02] a SKILL.md too long to review whole says so, and Update waits until you say you read it", async ({
  page,
}) => {
  const { url, upstream } = await hubWithGitSkill();
  // A change past the first 200,000 characters, which the review leaves out.
  const long = `Bump the version.\n${"Keep each step short. ".repeat(10_000)}`;
  upstream.commit({ "SKILL.md": skillMd(`${long}\nTag the release.`) });
  await page.goto(`${url}/#/skills?view=updates`);
  await page.getByRole("button", { name: "Check for updates" }).click();
  const main = page.getByRole("main", { name: "Skills" });
  const review = main.getByRole("article", { name: "Release" });
  await expect(review.getByRole("note")).toContainText("This SKILL.md is too long to show whole");
  const update = review.getByRole("button", { name: "Update and roll out to 1 hob" });
  await expect(update).toBeDisabled();
  await expectAccessible(page, main);
  await review.getByRole("checkbox", { name: /I read the whole SKILL.md/ }).check();
  await update.click();
  await expect(main).toContainText("Release r2 is in your library");
});
