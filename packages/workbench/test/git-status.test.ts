import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  renameSync,
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
  it("[TC-PE-1537-05] finds the repositories a folder reaches: the one around it and every one below it", async () => {
    const ledger = join(work, "projects", "ledger");
    const vendor = join(ledger, "vendor", "lib");
    const deep = join(work, "projects", "a", "b", "c", "deep");
    const hidden = join(work, "projects", ".worktrees", "task");
    for (const dir of [join(ledger, "src"), vendor, deep, hidden, join(work, "projects", "node_modules", "pkg")]) {
      mkdirSync(dir, { recursive: true });
    }
    for (const dir of [ledger, vendor, deep, hidden, join(work, "projects", "node_modules", "pkg")]) {
      gitIn(dir, "init", "-q");
    }
    // From inside a repository: that one. From a folder of checkouts: each, however deep or hidden,
    // past installed packages, and the scan saw every folder.
    expect(await read((git) => git.repositoriesIn(join(ledger, "src")))).toEqual({ tops: [ledger], complete: true });
    const reached = await read((git) => git.repositoriesIn(join(work, "projects")));
    expect([...reached.tops].sort()).toEqual([hidden, deep, ledger, vendor].sort());
    expect(reached.complete).toBe(true);
    expect(await read((git) => git.repositoriesIn(join(work, "missing")))).toEqual({ tops: [], complete: true });
  });

  const committed = (repo: string) => {
    write(join(repo, "a.md"), "a\n");
    gitIn(repo, "init", "-q", "-b", "main");
    gitIn(repo, "add", ".");
    gitIn(repo, "commit", "-q", "-m", "one");
  };
  const listing = (folder: string): ReadonlyArray<string> =>
    readdirSync(folder, { recursive: true, encoding: "utf8" }).sort();

  // covers PE-005, #1537
  it("[TC-PE-1537-06] closes a repository's refs and HEAD, its packed refs, or its whole Git folder while it has none, and writes nothing", async () => {
    const repo = join(work, "repo");
    committed(repo);
    gitIn(repo, "branch", "feat/shop");
    const dotGit = join(repo, ".git");
    const before = listing(dotGit);
    // No packed refs yet, which a hob could write a branch into: the Git folder is closed whole.
    expect(await read((git) => git.refStores(repo))).toEqual([dotGit, join(dotGit, "refs"), join(dotGit, "HEAD")]);
    expect(listing(dotGit)).toEqual(before);
    // With packed refs, the same fixed list: what the branches are named or how they are held is not read.
    gitIn(repo, "pack-refs", "--all");
    const stores = [join(dotGit, "packed-refs"), join(dotGit, "refs"), join(dotGit, "HEAD")];
    expect(await read((git) => git.refStores(repo))).toEqual(stores);
    gitIn(repo, "symbolic-ref", "refs/heads/alias", "refs/heads/main");
    expect(await read((git) => git.refStores(join(repo, "a.md")))).toEqual(stores);
    expect(await read((git) => git.refStores(join(work, "outside")))).toEqual([]);
  });

  // covers PE-005, #1537
  it("[TC-PE-1537-07] closes the shared refs and every worktree's own, and the .git file a worktree names its Git folder in", async () => {
    const repo = join(work, "main-repo");
    committed(repo);
    gitIn(repo, "pack-refs", "--all");
    const camp = join(work, "camp");
    gitIn(repo, "worktree", "add", "-q", "-b", "camp", camp);
    const dotGit = join(repo, ".git");
    const own = join(dotGit, "worktrees", "camp");
    const shared = [join(dotGit, "packed-refs"), join(dotGit, "refs"), join(dotGit, "HEAD")];
    const ownStores = ["refs", "HEAD", "commondir"].map((name) => join(own, name)).filter((path) => existsSync(path));
    expect(ownStores).toContain(join(own, "HEAD"));
    // From the worktree and from the main checkout alike, since a branch of either moves in both.
    expect(await read((git) => git.refStores(camp))).toEqual([...shared, ...ownStores, join(camp, ".git")]);
    expect(await read((git) => git.refStores(repo))).toEqual([...shared, ...ownStores]);
  });

  // covers PE-005, #1537
  it("[TC-PE-1537-09] closes where a link among the ref stores leads, as well as the link", async () => {
    const repo = join(work, "linked");
    committed(repo);
    gitIn(repo, "pack-refs", "--all");
    const dotGit = join(repo, ".git");
    renameSync(join(dotGit, "packed-refs"), join(work, "packed-elsewhere"));
    symlinkSync(join(work, "packed-elsewhere"), join(dotGit, "packed-refs"));
    renameSync(join(dotGit, "refs"), join(work, "refs-elsewhere"));
    symlinkSync(join(work, "refs-elsewhere"), join(dotGit, "refs"));
    expect(gitIn(repo, "rev-parse", "--abbrev-ref", "HEAD").toString().trim()).toBe("main");
    expect(await read((git) => git.refStores(repo))).toEqual([
      join(dotGit, "packed-refs"),
      join(work, "packed-elsewhere"),
      join(dotGit, "refs"),
      join(work, "refs-elsewhere"),
      join(dotGit, "HEAD"),
    ]);
  });

  // covers PE-005, STD-SEC-002, #1537
  it("[TC-PE-1537-10] reads a Git folder a hob's .git file points to outside, writes nothing there, and closes its ref stores", async () => {
    const outside = join(work, "elsewhere");
    committed(outside);
    gitIn(outside, "pack-refs", "--all");
    const folder = join(work, "allowed");
    write(join(folder, ".git"), `gitdir: ${join(outside, ".git")}\n`);
    const before = listing(join(outside, ".git"));
    expect(await read((git) => git.refStores(folder))).toEqual([
      join(outside, ".git", "packed-refs"),
      join(outside, ".git", "refs"),
      join(outside, ".git", "HEAD"),
      join(folder, ".git"),
    ]);
    expect(listing(join(outside, ".git"))).toEqual(before);
  });

  // covers PE-005, #1537
  it("[TC-PE-1537-12] closes a repository's ref table, and where a link to it leads", async () => {
    const repo = join(work, "tabled");
    committed(repo);
    gitIn(repo, "pack-refs", "--all");
    const dotGit = join(repo, ".git");
    const store = join(work, "store");
    mkdirSync(store);
    symlinkSync(store, join(dotGit, "reftable"));
    expect(await read((git) => git.refStores(repo))).toEqual([
      join(dotGit, "packed-refs"),
      join(dotGit, "reftable"),
      store,
      join(dotGit, "refs"),
      join(dotGit, "HEAD"),
    ]);
  });
});
