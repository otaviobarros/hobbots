import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Effect } from "effect";
import { afterAll, describe, expect, it } from "vitest";
import { type PreparedSandbox, ProcessSandbox } from "../src/sandbox.ts";

// #1537: what you took over from a Task stays closed in every hob turn's sandbox, whatever the hob
// runs. A script writes a taken file through a variable, an interpreter or a move: each fails in the
// sandbox, which closes the taken folder, while the rest of the folder and Git's own work stay open.
// A taken branch is left to the call-level check (#1449).

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
  it.runIf(sandboxed)(
    "fails every write to a taken folder, and leaves the rest of the folder and Git open",
    async () => {
      hubGit("init", "--quiet", "-b", "main");
      mkdirSync(join(project, "docs"));
      writeFileSync(join(project, "docs", "plan.md"), "plan\n");
      writeFileSync(join(project, "README.md"), "hello\n");
      hubGit("add", ".");
      hubGit("commit", "--quiet", "-m", "First");

      await turnWith([join(project, "docs")], async (prepared) => {
        // A script that names the file only through a variable, an interpreter, a delete and a move.
        for (const write of [
          'f=docs/plan.md; echo changed > "$f"',
          "sh -c 'echo new > docs/new.md'",
          "rm docs/plan.md",
          "mv docs elsewhere",
        ]) {
          const result = await runIn(prepared, write);
          expect(result.ok, `${write} should fail`).toBe(false);
        }
        // The rest of the folder stays open, and so does Git's own work there.
        for (const write of [
          "echo notes > notes.md",
          "git add notes.md",
          `git ${AS_NETTLE} commit --quiet -m Second`,
          "git branch review",
        ]) {
          const result = await runIn(prepared, write);
          expect(result.ok, `${write} should run: ${result.stderr}`).toBe(true);
        }
      });

      expect(readFileSync(join(project, "docs", "plan.md"), "utf8")).toBe("plan\n");
      expect(existsSync(join(project, "docs", "new.md"))).toBe(false);
      expect(readFileSync(join(project, "notes.md"), "utf8")).toBe("notes\n");
      expect(hubGit("log", "-1", "--format=%s", "main")).toBe("Second");
      expect(hubGit("branch", "--list", "review")).toContain("review");

      // Given back, the next turn's sandbox lets the folder be written again.
      await turnWith([], async (prepared) => {
        const written = await runIn(prepared, "echo changed > docs/plan.md");
        expect(written.ok, written.stderr).toBe(true);
      });
      expect(readFileSync(join(project, "docs", "plan.md"), "utf8")).toBe("changed\n");
    },
    120_000,
  );
});
