import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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

describe("The repository Git finds from a folder (#742)", () => {
  const repositoryFrom = (folder: string) =>
    Effect.runPromise(
      Effect.flatMap(Effect.service(GitWorkspace), (git) => git.repository(folder)).pipe(
        Effect.provide(GitWorkspaceLive),
      ),
    );

  // covers OR-004, PE-005
  it("[TC-OR-742-04] names one repository however its folder is spelled, a nested one as its own, and none outside any", async () => {
    const ledger = join(work, "ledger");
    const notes = join(work, "notes");
    const vendor = join(ledger, "vendor");
    for (const dir of [join(ledger, "src"), notes, vendor]) mkdirSync(dir, { recursive: true });
    gitIn(ledger, "init", "-q");
    gitIn(vendor, "init", "-q");
    symlinkSync(ledger, join(work, "ledger-link"));
    for (const spelling of [ledger, join(ledger, "src"), `${notes}/../ledger`, join(work, "ledger-link", "src")]) {
      expect(await repositoryFrom(spelling), spelling).toBe(ledger);
    }
    // A link is followed before the `..` after it, as Git's own `-C` is: through a link to the
    // ledger's src, `..` is the ledger, never the folder that holds the link, which is in none.
    symlinkSync(join(ledger, "src"), join(work, "src-link"));
    expect(await repositoryFrom(`${join(work, "src-link")}/..`)).toBe(ledger);
    expect(await repositoryFrom(`${join(notes, "..", "src-link")}/..`)).toBe(ledger);
    // A repository nested in another is its own; a folder in none, or missing, has none.
    expect(await repositoryFrom(vendor)).toBe(vendor);
    expect(await repositoryFrom(notes)).toBeNull();
    expect(await repositoryFrom(join(work, "missing"))).toBeNull();
    expect(await repositoryFrom("ledger")).toBeNull();
  });
});

describe("What the sandbox closes for what you took over (#1537)", () => {
  const read = <A>(use: (git: GitWorkspace["Service"]) => Effect.Effect<A>) =>
    Effect.runPromise(Effect.flatMap(Effect.service(GitWorkspace), use).pipe(Effect.provide(GitWorkspaceLive)));

  // covers PE-005, #1537
  it("[TC-PE-1537-05] finds the repositories a folder reaches: the one around it and those a few folders down", async () => {
    const ledger = join(work, "projects", "ledger");
    const vendor = join(ledger, "vendor", "lib");
    const deep = join(work, "projects", "a", "b", "c", "deep");
    for (const dir of [join(ledger, "src"), vendor, deep, join(work, "projects", "node_modules", "pkg")]) {
      mkdirSync(dir, { recursive: true });
    }
    for (const dir of [ledger, vendor, deep, join(work, "projects", "node_modules", "pkg")]) gitIn(dir, "init", "-q");
    // From inside a repository: that one. From a folder of checkouts: each, past installed packages,
    // but not one deeper than the scan reaches, which the call-level check still covers.
    expect(await read((git) => git.repositoriesIn(join(ledger, "src")))).toEqual([ledger]);
    expect([...(await read((git) => git.repositoriesIn(join(work, "projects"))))].sort()).toEqual([ledger, vendor]);
    expect(await read((git) => git.repositoriesIn(join(work, "missing")))).toEqual([]);
  });

  // covers PE-005, #1537
  it("[TC-PE-1537-06] names the files that move a branch, writing back a packed-only branch's loose ref, and none for a branch not made", async () => {
    const repo = join(work, "repo");
    write(join(repo, "a.md"), "a\n");
    gitIn(repo, "init", "-q", "-b", "main");
    gitIn(repo, "add", ".");
    gitIn(repo, "commit", "-q", "-m", "one");
    gitIn(repo, "branch", "feat/shop");
    const loose = join(repo, ".git", "refs", "heads", "feat", "shop");
    const packed = join(repo, ".git", "packed-refs");
    expect(await read((git) => git.branchFiles(repo, "feat/shop"))).toEqual([loose]);
    const commit = gitIn(repo, "rev-parse", "feat/shop").toString().trim();
    gitIn(repo, "pack-refs", "--all");
    expect(await read((git) => git.branchFiles(repo, "feat/shop"))).toEqual([loose, packed]);
    expect(gitIn(repo, "rev-parse", "feat/shop").toString().trim()).toBe(commit);
    expect(gitIn(repo, "show-ref", "--verify", "refs/heads/feat/shop").toString()).toContain(commit);
    expect(await read((git) => git.branchFiles(repo, "feat/new"))).toEqual([packed]);
    expect(await read((git) => git.branchFiles(repo, "../../config"))).toEqual([packed]);
    // A linked worktree's branches are in the main repository's Git folder.
    const camp = join(work, "camp");
    gitIn(repo, "worktree", "add", "-q", "-b", "camp", camp);
    expect(await read((git) => git.branchFiles(camp, "camp"))).toEqual([
      join(repo, ".git", "refs", "heads", "camp"),
      packed,
    ]);
  });

  // covers PE-005, #1537
  it("[TC-PE-1537-07] leaves a packed-only branch's loose ref unwritten while Git holds its lock or a link stands in its path, and closes the folder around it instead", async () => {
    const repo = join(work, "locked");
    write(join(repo, "a.md"), "a\n");
    gitIn(repo, "init", "-q", "-b", "main");
    gitIn(repo, "add", ".");
    gitIn(repo, "commit", "-q", "-m", "one");
    gitIn(repo, "branch", "feat/shop");
    gitIn(repo, "branch", "side/shop");
    gitIn(repo, "pack-refs", "--all");
    const heads = join(repo, ".git", "refs", "heads");
    const packed = join(repo, ".git", "packed-refs");
    // Git is moving the branch: its lock is held, so nothing is written over it, and the folder
    // Git would publish the ref in is closed.
    mkdirSync(join(heads, "feat"), { recursive: true });
    write(join(heads, "feat", "shop.lock"), "moving\n");
    expect(await read((git) => git.branchFiles(repo, "feat/shop"))).toEqual([join(heads, "feat"), packed]);
    expect(existsSync(join(heads, "feat", "shop"))).toBe(false);
    expect(readFileSync(join(heads, "feat", "shop.lock"), "utf8")).toBe("moving\n");
    // A link where a folder of the ref should be is never followed out of the repository: the folder
    // it stands in and the folder it leads to are closed.
    const outside = join(work, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(heads, "side"));
    expect(await read((git) => git.branchFiles(repo, "side/shop"))).toEqual([heads, outside, packed]);
    expect(readdirSync(outside)).toEqual([]);
  });

  // covers PE-005, #1537
  it("[TC-PE-1537-09] closes the ref a symbolic branch names, since moving it moves the branch", async () => {
    const repo = join(work, "symbolic");
    write(join(repo, "a.md"), "a\n");
    gitIn(repo, "init", "-q", "-b", "main");
    gitIn(repo, "add", ".");
    gitIn(repo, "commit", "-q", "-m", "one");
    gitIn(repo, "symbolic-ref", "refs/heads/alias", "refs/heads/main");
    gitIn(repo, "symbolic-ref", "refs/heads/loop", "refs/heads/loop");
    const heads = join(repo, ".git", "refs", "heads");
    expect(await read((git) => git.branchFiles(repo, "alias"))).toEqual([join(heads, "alias"), join(heads, "main")]);
    // A ref that names itself is followed only a few times.
    expect(await read((git) => git.branchFiles(repo, "loop"))).toEqual([join(heads, "loop")]);
  });

  // covers PE-005, STD-SEC-002, #1537
  it("[TC-PE-1537-10] writes no ref in a Git folder a hob's .git file points to outside, and closes around it instead", async () => {
    const outside = join(work, "elsewhere");
    write(join(outside, "a.md"), "a\n");
    gitIn(outside, "init", "-q", "-b", "main");
    gitIn(outside, "add", ".");
    gitIn(outside, "commit", "-q", "-m", "one");
    gitIn(outside, "branch", "taken");
    gitIn(outside, "pack-refs", "--all");
    const folder = join(work, "allowed");
    write(join(folder, ".git"), `gitdir: ${join(outside, ".git")}\n`);
    const heads = join(outside, ".git", "refs", "heads");
    expect(await read((git) => git.branchFiles(folder, "taken"))).toEqual([
      heads,
      join(outside, ".git", "packed-refs"),
    ]);
    expect(existsSync(join(heads, "taken"))).toBe(false);
  });

  // covers PE-005, #1537
  it("[TC-PE-1537-11] closes a worktree's own ref that a symbolic branch names, in that worktree's Git folder", async () => {
    const repo = join(work, "main-repo");
    write(join(repo, "a.md"), "a\n");
    gitIn(repo, "init", "-q", "-b", "main");
    gitIn(repo, "add", ".");
    gitIn(repo, "commit", "-q", "-m", "one");
    const camp = join(work, "camp-tree");
    gitIn(repo, "worktree", "add", "-q", "-b", "camp", camp);
    gitIn(camp, "update-ref", "refs/worktree/target", "HEAD");
    gitIn(camp, "symbolic-ref", "refs/heads/alias", "refs/worktree/target");
    gitIn(camp, "symbolic-ref", "refs/heads/later", "refs/worktree/later");
    const own = join(repo, ".git", "worktrees", "camp-tree");
    const heads = join(repo, ".git", "refs", "heads");
    expect(await read((git) => git.branchFiles(camp, "alias"))).toEqual([
      join(heads, "alias"),
      join(own, "refs", "worktree", "target"),
    ]);
    // A ref it names that is not made yet would move it once made: the folder it goes in is closed.
    expect(await read((git) => git.branchFiles(camp, "later"))).toEqual([
      join(heads, "later"),
      join(own, "refs", "worktree"),
    ]);
  });
});
