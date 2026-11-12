import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Effect } from "effect";
import { afterAll, describe, expect, it } from "vitest";
import { type PreparedSandbox, ProcessSandbox } from "../src/sandbox.ts";

// #1344: a hob with Edit files Never and Run commands Allow gets read-only commands. The turn's
// sandbox closes its folders, `.git` included, to every write, so Git commands that only read and
// tests that write nothing there work, and anything that writes in the folders fails.

// The real OS sandbox runs on macOS, and on Linux with HOBBOTS_SANDBOX_TESTS=1 where bubblewrap,
// socat and sandbox-runtime's seccomp helper are installed (as in sandbox-hub.test.ts).
const sandboxed = process.platform === "darwin" || process.env.HOBBOTS_SANDBOX_TESTS === "1";

const root = realpathSync(mkdtempSync(join(tmpdir(), "hobbots-read-only-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const project = join(root, "project");
const data = join(root, "data");
const runtimes = join(root, "runtimes");
for (const dir of [project, data, runtimes]) mkdirSync(dir);

/** Git on the hub, outside any sandbox. */
const hubGit = (...args: Array<string>) =>
  execFileSync("git", args, {
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  });

/** Runs a shell script in the turn's sandbox, in the project, without blocking. */
const runIn = async (prepared: PreparedSandbox, script: string) => {
  const { command, args, env } = prepared.spawnArgs("/bin/sh", ["-c", script], {
    PATH: "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin",
  });
  return promisify(execFile)(command, [...args], { cwd: project, env, encoding: "utf8" }).then(
    ({ stdout, stderr }) => ({ ok: true, stdout, stderr }),
    (error: { stdout?: string; stderr?: string }) => ({
      ok: false,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
    }),
  );
};

/** A turn's sandbox over the project with Edit files Never, for the length of `use`. */
const readOnlyTurn = <A>(use: (prepared: PreparedSandbox) => Promise<A>) =>
  Effect.gen(function* () {
    const sandbox = yield* ProcessSandbox;
    expect(sandbox.state, sandbox.evidence).toBe("on");
    return yield* Effect.acquireUseRelease(
      sandbox.prepare({
        folders: [project],
        folderAccess: { read: true, write: false },
        dataFolder: data,
        binary: "/bin/sh",
        runtimeFolder: join(runtimes, "hob-1"),
        allowedHosts: [],
      }),
      (prepared) => Effect.promise(() => use(prepared)),
      (prepared) => Effect.sync(prepared.release),
    );
  }).pipe(Effect.provide(ProcessSandbox.layer), Effect.scoped, Effect.runPromise);

const AS_NETTLE = "-c user.name=Nettle -c user.email=nettle@example.com";

describe("read-only commands in the sandbox", () => {
  // covers PE-005, PE-006
  it.runIf(sandboxed)(
    "[TC-PE-1318] reads the folder and its Git history, runs a read-only test, and fails every write to the folder and its .git",
    async () => {
      hubGit("init", "--quiet", "--template=", "--", project);
      writeFileSync(join(project, "README.md"), "hello\n");
      hubGit("-C", project, "add", "README.md");
      hubGit(
        "-C",
        project,
        "-c",
        "user.name=Ada",
        "-c",
        "user.email=ada@example.com",
        "commit",
        "--quiet",
        "-m",
        "First",
      );
      // A change in the working tree, so `git diff` has something to show.
      writeFileSync(join(project, "README.md"), "hello\nworld\n");
      const head = hubGit("-C", project, "rev-parse", "HEAD").trim();
      const index = readFileSync(join(project, ".git", "index"));
      const branch = hubGit("-C", project, "branch", "--show-current").trim();

      await readOnlyTurn(async (prepared) => {
        const log = await runIn(prepared, "git log --oneline");
        expect(log.ok, log.stderr).toBe(true);
        expect(log.stdout).toContain("First");
        const diff = await runIn(prepared, "git diff");
        expect(diff.ok, diff.stderr).toBe(true);
        expect(diff.stdout).toContain("+world");
        const status = await runIn(prepared, "git status --short");
        expect(status.ok, status.stderr).toBe(true);
        expect(status.stdout).toContain("README.md");
        // Git takes no optional lock, so `git status` never tries to refresh the index.
        expect((await runIn(prepared, 'printf %s "$GIT_OPTIONAL_LOCKS"')).stdout).toBe("0");
        // A test that writes nothing in the folder, only in the turn's own TMPDIR, passes.
        const test = await runIn(
          prepared,
          'grep -q world README.md && echo passed > "$TMPDIR/result" && cat "$TMPDIR/result"',
        );
        expect(test.ok, test.stderr).toBe(true);
        expect(test.stdout.trim()).toBe("passed");

        for (const write of [
          "echo new > notes.md",
          "echo changed >> README.md",
          "mkdir build",
          "rm README.md",
          `git ${AS_NETTLE} commit --quiet --no-gpg-sign -am Second`,
          "git checkout -b review",
          "echo ref > .git/refs/heads/planted",
          "echo hook > .git/hooks/pre-commit",
          "echo x > .git/new-file",
        ]) {
          const result = await runIn(prepared, write);
          expect(result.ok, `${write} should fail`).toBe(false);
        }
      });

      // Nothing in the folder or its .git changed.
      expect(existsSync(join(project, "notes.md"))).toBe(false);
      expect(existsSync(join(project, "build"))).toBe(false);
      expect(readFileSync(join(project, "README.md"), "utf8")).toBe("hello\nworld\n");
      expect(hubGit("-C", project, "rev-parse", "HEAD").trim()).toBe(head);
      expect(hubGit("-C", project, "branch", "--list").trim()).toBe(`* ${branch}`);
      expect(existsSync(join(project, ".git", "refs", "heads", "planted"))).toBe(false);
      expect(existsSync(join(project, ".git", "hooks", "pre-commit"))).toBe(false);
      expect(existsSync(join(project, ".git", "new-file"))).toBe(false);
      expect(readFileSync(join(project, ".git", "index")).equals(index)).toBe(true);
    },
    120_000,
  );
});
