import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Effect } from "effect";
import { afterAll, describe, expect, it } from "vitest";
import { type PreparedSandbox, ProcessSandbox } from "../src/sandbox.ts";

// #1537: what you took over from a Task stays closed in every hob turn's sandbox, whatever the hob
// runs. A script writes a taken file through a variable, and Git moves a branch through any of its
// commands or its config: each fails in the sandbox, which closes the taken folder and, while a
// branch of the repository is taken, the repository's whole ref store (see GitWorkspace.refStores),
// so no branch there moves. The rest of the folder stays writable.

// The real OS sandbox runs on macOS, and on Linux with HOBBOTS_SANDBOX_TESTS=1 where bubblewrap,
// socat and sandbox-runtime's seccomp helper are installed (as in sandbox-hub.test.ts).
const sandboxed = process.platform === "darwin" || process.env.HOBBOTS_SANDBOX_TESTS === "1";

const root = realpathSync(mkdtempSync(join(tmpdir(), "hobbots-taken-sandbox-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const project = join(root, "project");
const data = join(root, "data");
const runtimes = join(root, "runtimes");
for (const dir of [project, data, runtimes]) mkdirSync(dir);

const GIT_ENV = { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
/** Git on the hub, outside any sandbox. */
const hubGit = (...args: Array<string>) =>
  execFileSync("git", ["-C", project, "-c", "user.name=Ada", "-c", "user.email=ada@example.com", ...args], {
    encoding: "utf8",
    env: GIT_ENV,
  }).trim();

/** Runs a shell script in the turn's sandbox, in the project. */
const runIn = async (prepared: PreparedSandbox, script: string) => {
  const { command, args, env } = prepared.spawnArgs("/bin/sh", ["-c", script], {
    PATH: "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin",
  });
  return promisify(execFile)(command, [...args], { cwd: project, env, encoding: "utf8" }).then(
    () => ({ ok: true, stderr: "" }),
    (error: { stderr?: string }) => ({ ok: false, stderr: error.stderr ?? "" }),
  );
};

/** A turn's sandbox over the project, with `taken` closed, for the length of `use`. */
const turnWith = <A>(taken: ReadonlyArray<string>, use: (prepared: PreparedSandbox) => Promise<A>) =>
  Effect.gen(function* () {
    const sandbox = yield* ProcessSandbox;
    expect(sandbox.state, sandbox.evidence).toBe("on");
    return yield* Effect.acquireUseRelease(
      sandbox.prepare({
        folders: [project],
        folderAccess: { read: true, write: true },
        dataFolder: data,
        binary: "/bin/sh",
        runtimeFolder: join(runtimes, "hob-1"),
        allowedHosts: [],
        taken,
      }),
      (prepared) => Effect.promise(() => use(prepared)),
      (prepared) => Effect.sync(prepared.release),
    );
  }).pipe(Effect.provide(ProcessSandbox.layer), Effect.scoped, Effect.runPromise);

const AS_NETTLE = "-c user.name=Nettle -c user.email=nettle@example.com -c commit.gpgsign=false";

describe("what you took over, in a hob turn's sandbox", () => {
  // covers PE-005, OR-006, #1537
  it.runIf(sandboxed)(
    "[TC-PE-1537-02] fails every write to a taken folder and every branch move in a repository with a taken branch, and leaves the rest open",
    async () => {
      hubGit("init", "--quiet", "-b", "main");
      mkdirSync(join(project, "docs"));
      writeFileSync(join(project, "docs", "plan.md"), "plan\n");
      writeFileSync(join(project, "README.md"), "hello\n");
      hubGit("add", ".");
      hubGit("commit", "--quiet", "-m", "First");
      writeFileSync(join(project, "README.md"), "hello again\n");
      hubGit("commit", "--quiet", "-am", "Second");
      hubGit("branch", "feat/shop", "HEAD~1");
      // A remote that fetches into the taken branch, as a hob could set in the repository's config.
      hubGit("remote", "add", "self", project);
      // feat/packed is held only in the packed refs, feat/shop also as a loose ref.
      hubGit("branch", "feat/packed", "HEAD~1");
      hubGit("pack-refs", "--all");
      const git = join(project, ".git");
      mkdirSync(join(git, "refs", "heads", "feat"), { recursive: true });
      writeFileSync(join(git, "refs", "heads", "feat", "shop"), `${hubGit("rev-parse", "feat/shop")}\n`);
      const shop = hubGit("rev-parse", "feat/shop");
      const main = hubGit("rev-parse", "main");
      // What the hub closes for `docs` and a taken branch: the repository's ref store.
      const taken = [join(project, "docs"), join(git, "packed-refs"), join(git, "refs"), join(git, "HEAD")];

      await turnWith(taken, async (prepared) => {
        // A script that names the file only through a variable, and an interpreter.
        for (const write of [
          'f=docs/plan.md; echo changed > "$f"',
          "sh -c 'echo new > docs/new.md'",
          "rm docs/plan.md",
          "mv docs elsewhere",
        ]) {
          const result = await runIn(prepared, write);
          expect(result.ok, `${write} should fail`).toBe(false);
        }
        // Every way Git moves, makes or deletes a branch, its config included, leaves them all where they were.
        for (const branch of ["feat/shop", "feat/packed", "main", "review"]) {
          for (const move of [
            `git update-ref refs/heads/${branch} HEAD`,
            `git branch -f ${branch} HEAD`,
            `git branch -D ${branch}`,
            `git fetch --quiet self +refs/heads/main:refs/heads/${branch}`,
            `git -c remote.self.fetch=+refs/heads/main:refs/heads/${branch} fetch --quiet self`,
            "git pack-refs --all --prune",
            `git checkout --quiet ${branch} && git ${AS_NETTLE} commit --quiet --allow-empty -m Third`,
          ]) {
            await runIn(prepared, `${move}; git checkout --quiet main`);
            expect(hubGit("rev-parse", "feat/shop"), `${move} should leave feat/shop alone`).toBe(shop);
            expect(hubGit("rev-parse", "feat/packed"), `${move} should leave feat/packed alone`).toBe(shop);
            expect(hubGit("rev-parse", "main"), `${move} should leave main alone`).toBe(main);
          }
        }
        // The rest of the folder stays open, and Git still reads the repository.
        for (const write of ["echo notes > notes.md", "git status --short", "git log -1 --format=%s feat/shop"]) {
          const result = await runIn(prepared, write);
          expect(result.ok, `${write} should run: ${result.stderr}`).toBe(true);
        }
      });

      expect(readFileSync(join(project, "docs", "plan.md"), "utf8")).toBe("plan\n");
      expect(existsSync(join(project, "docs", "new.md"))).toBe(false);
      expect(readFileSync(join(project, "notes.md"), "utf8")).toBe("notes\n");
      expect(hubGit("branch", "--list", "review")).toBe("");

      // Given back, the next turn's sandbox lets Git move the branch again.
      await turnWith([], async (prepared) => {
        const moved = await runIn(prepared, "git branch -f feat/shop main");
        expect(moved.ok, moved.stderr).toBe(true);
      });
      expect(hubGit("rev-parse", "feat/shop")).toBe(hubGit("rev-parse", "main"));
    },
    120_000,
  );
});
