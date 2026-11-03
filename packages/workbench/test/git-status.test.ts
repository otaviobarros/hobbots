import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitWorkspace } from "@hobbots/agents";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitWorkspaceLive } from "../src/git-status.ts";

// Issue #586: which files a Task left uncommitted, read from the repository's files without
// running Git.

let work: string;
beforeEach(() => {
  work = realpathSync(mkdtempSync(join(tmpdir(), "hobbots-git-status-")));
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

const gitIn = (dir: string, ...args: ReadonlyArray<string>) =>
  execFileSync(
    "git",
    ["-c", "commit.gpgsign=false", "-c", "user.name=Test", "-c", "user.email=test@example.com", ...args],
    {
      cwd: dir,
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    },
  );

const uncommitted = (files: ReadonlyArray<{ folder: string; path: string }>) =>
  Effect.runPromise(
    Effect.flatMap(Effect.service(GitWorkspace), (git) => git.uncommitted(files)).pipe(
      Effect.provide(GitWorkspaceLive),
    ),
  );

const write = (path: string, text: string) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
};

describe("Uncommitted files", () => {
  it("counts staged, unstaged, new and deleted files, and leaves out committed and ignored ones", async () => {
    const repo = join(work, "repo");
    write(join(repo, "a.md"), "a\n");
    write(join(repo, "b.md"), "b\n");
    write(join(repo, "gone.md"), "gone\n");
    write(join(repo, "same.md"), "same\n");
    write(join(repo, ".gitignore"), "build/\n");
    gitIn(repo, "init", "-q");
    gitIn(repo, "add", ".");
    gitIn(repo, "commit", "-q", "-m", "one");
    write(join(repo, "a.md"), "a, edited\n");
    write(join(repo, "b.md"), "b, staged\n");
    gitIn(repo, "add", "b.md");
    write(join(repo, "new.md"), "new\n");
    write(join(repo, "build", "out.js"), "out\n");
    rmSync(join(repo, "gone.md"));
    const found = await uncommitted(
      ["a.md", "b.md", "gone.md", "same.md", "new.md", "build/out.js"].map((path) => ({ folder: repo, path })),
    );
    expect(found).toEqual([{ repository: repo, paths: ["a.md", "b.md", "gone.md", "new.md"] }]);
  });

  it("finds the repository above a hob's folder and a nested one inside it, and nothing outside any", async () => {
    const outer = join(work, "outer");
    write(join(outer, "app", "x.md"), "x\n");
    gitIn(outer, "init", "-q");
    gitIn(outer, "add", ".");
    gitIn(outer, "commit", "-q", "-m", "one");
    const inner = join(outer, "app", "vendor");
    write(join(inner, "y.md"), "y\n");
    gitIn(inner, "init", "-q");
    gitIn(inner, "add", ".");
    gitIn(inner, "commit", "-q", "-m", "one");
    write(join(outer, "app", "x.md"), "x, edited\n");
    write(join(inner, "y.md"), "y, edited\n");
    write(join(work, "loose.md"), "loose\n");
    const found = await uncommitted([
      { folder: join(outer, "app"), path: "x.md" },
      { folder: join(outer, "app"), path: "vendor/y.md" },
      { folder: work, path: "loose.md" },
    ]);
    expect(found).toEqual([
      { repository: outer, paths: ["app/x.md"] },
      { repository: inner, paths: ["y.md"] },
    ]);
  });

  it("treats every file of a repository with no commit yet as uncommitted", async () => {
    const repo = join(work, "fresh");
    write(join(repo, "a.md"), "a\n");
    gitIn(repo, "init", "-q");
    expect(await uncommitted([{ folder: repo, path: "a.md" }])).toEqual([{ repository: repo, paths: ["a.md"] }]);
  });
});
