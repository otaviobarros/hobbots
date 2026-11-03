import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitWorkspace } from "@hobbots/agents";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitWorkspaceLive } from "../src/git-status.ts";

// Issue #586, after review: a linked worktree keeps its HEAD and index in a Git folder of its own,
// and its branches and objects in the main repository's, so both are read.

let work: string;
let main: string;
beforeEach(() => {
  work = realpathSync(mkdtempSync(join(tmpdir(), "hobbots-worktrees-")));
  main = join(work, "site");
  mkdirSync(join(main, "docs"), { recursive: true });
  writeFileSync(join(main, "docs", "SPEC.md"), "# Spec\n");
  writeFileSync(join(main, "README.md"), "# Site\n");
  gitIn(main, "init", "-q", "-b", "main");
  gitIn(main, "add", ".");
  gitIn(main, "commit", "-q", "-m", "First version");
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

function gitIn(dir: string, ...args: ReadonlyArray<string>) {
  return execFileSync(
    "git",
    ["-c", "commit.gpgsign=false", "-c", "user.name=Test", "-c", "user.email=test@example.com", ...args],
    { cwd: dir, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } },
  );
}

const uncommitted = (folder: string, paths: ReadonlyArray<string>) =>
  Effect.runPromise(
    Effect.flatMap(Effect.service(GitWorkspace), (git) =>
      git.uncommitted(paths.map((path) => ({ folder, path }))),
    ).pipe(Effect.provide(GitWorkspaceLive)),
  );

describe("Uncommitted files in a linked worktree", () => {
  it("are none when the worktree's branch has every file committed, even one the main branch lacks", async () => {
    const tree = join(work, "feature");
    gitIn(main, "worktree", "add", "-q", "-b", "feature", tree);
    writeFileSync(join(tree, "NOTES.md"), "Notes\n");
    gitIn(tree, "add", "NOTES.md");
    gitIn(tree, "commit", "-q", "-m", "Notes");
    expect(await uncommitted(tree, ["docs/SPEC.md", "README.md", "NOTES.md"])).toEqual([]);
  });

  it("are the files changed, staged or new since the worktree's own last commit", async () => {
    const tree = join(work, "feature");
    gitIn(main, "worktree", "add", "-q", "-b", "feature", tree);
    writeFileSync(join(tree, "docs", "SPEC.md"), "# Spec\n\nChanged.\n");
    writeFileSync(join(tree, "NOTES.md"), "Notes\n");
    writeFileSync(join(tree, "README.md"), "# Site\n\nStaged.\n");
    gitIn(tree, "add", "README.md");
    // The main worktree's own change is not the linked one's.
    writeFileSync(join(main, "README.md"), "# Site\n\nOnly in main.\n");
    expect(await uncommitted(tree, ["docs/SPEC.md", "NOTES.md", "README.md"])).toEqual([
      { repository: tree, paths: ["NOTES.md", "README.md", "docs/SPEC.md"] },
    ]);
  });

  it("are read from a detached worktree's own commit", async () => {
    writeFileSync(join(main, "README.md"), "# Site\n\nSecond.\n");
    gitIn(main, "commit", "-q", "-am", "Second");
    const tree = join(work, "detached");
    gitIn(main, "worktree", "add", "-q", "--detach", tree, "HEAD~1");
    expect(await uncommitted(tree, ["README.md", "docs/SPEC.md"])).toEqual([]);
    writeFileSync(join(tree, "docs", "SPEC.md"), "# Spec\n\nChanged.\n");
    expect(await uncommitted(tree, ["README.md", "docs/SPEC.md"])).toEqual([
      { repository: tree, paths: ["docs/SPEC.md"] },
    ]);
  });
});
