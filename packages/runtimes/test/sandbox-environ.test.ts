import { type ChildProcess, execFile, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ProcessSandbox } from "../src/sandbox.ts";

// The hub hands the memory engine its two bearers in its environment, and nowhere else (ADR 028).
// That holds only if a hob's commands cannot read another process's environment, as `ps eww` or
// /proc/<pid>/environ would for any process of the same user. This starts a process that holds a
// marker in its environment, as the engine holds its bearers, and reads it from inside the real OS
// sandbox (Seatbelt on macOS, bubblewrap on Linux) every way a command could. Like the sandbox's
// other cases, it runs on macOS, and on Linux with HOBBOTS_SANDBOX_TESTS=1.
const enabled = process.platform === "darwin" || process.env.HOBBOTS_SANDBOX_TESTS === "1";

const root = realpathSync(mkdtempSync(join(tmpdir(), "hobbots-sandbox-environ-")));
const project = join(root, "project");
const data = join(root, "data");
const runtimes = join(root, "runtimes");
for (const dir of [project, data, runtimes]) mkdirSync(dir);

const MARKER = `hobbots-environ-marker-${process.pid}-${Date.now()}`;
let holder: ChildProcess | undefined;

beforeAll(() => {
  // Stands in for the memory engine: a long-lived process of the same user, with a bearer in its environment.
  holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    env: { AI_MEMORY_AUTH__ACTOR_PROXY_BEARER_TOKEN: MARKER, PATH: "/usr/bin:/bin" },
    stdio: "ignore",
  });
});
afterAll(() => {
  holder?.kill("SIGKILL");
  rmSync(root, { recursive: true, force: true });
});

const exec = (
  command: string,
  args: ReadonlyArray<string>,
  options: { readonly cwd?: string; readonly env: NodeJS.ProcessEnv },
) =>
  Effect.callback<string>((resume) => {
    execFile(command, [...args], { ...options, encoding: "utf8", timeout: 20_000 }, (_, stdout, stderr) =>
      resume(Effect.succeed(`${stdout}\n${stderr}`)),
    );
  });

/** Every way a command could read the holder's environment. */
const reads = (pid: number) => [
  `ps eww -p ${pid}`,
  `ps -E -ww -o command= -p ${pid}`,
  `cat /proc/${pid}/environ`,
  `tr '\\0' '\\n' < /proc/${pid}/environ`,
  `ps aeww`,
];

describe("the process sandbox and other processes' environments", () => {
  // covers PE-005, ADR 028
  it.runIf(enabled)(
    "[TC-PE-455] a sandboxed command cannot read the environment of another process of the same user",
    async () => {
      const pid = holder?.pid ?? 0;
      expect(pid).toBeGreaterThan(0);
      await Effect.gen(function* () {
        const sandbox = yield* ProcessSandbox;
        expect(sandbox.state, sandbox.evidence).toBe("on");
        const prepared = yield* sandbox.prepare({
          folders: [project],
          folderAccess: { read: true, write: true },
          dataFolder: data,
          binary: "/bin/sh",
          runtimeFolder: join(runtimes, "hob-1"),
          allowedHosts: [],
          decideHost: async () => true,
        });
        try {
          const run = (script: string) => {
            const { command, args, env } = prepared.spawnArgs("/bin/sh", ["-c", script], { PATH: "/usr/bin:/bin" });
            return exec(command, args, { cwd: project, env });
          };
          // Commands do run in the sandbox, so a miss below is the sandbox's doing, not one that never started.
          const ran = yield* run("echo ran");
          expect(ran.trim(), ran).toBe("ran");
          // Outside the sandbox, one of the same reads finds the marker, so the reads below would too.
          const outside = yield* Effect.forEach(reads(pid), (script) =>
            exec("/bin/sh", ["-c", script], { env: { PATH: "/usr/bin:/bin" } }),
          );
          expect(outside.join("\n")).toContain(MARKER);

          for (const script of reads(pid)) {
            expect(yield* run(script), script).not.toContain(MARKER);
          }
        } finally {
          prepared.release();
        }
      }).pipe(Effect.provide(ProcessSandbox.layer), Effect.scoped, Effect.runPromise);
    },
    120_000,
  );
});
