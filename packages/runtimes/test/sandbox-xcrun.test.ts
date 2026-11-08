import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterAll, describe, expect, it } from "vitest";
import { ProcessSandbox } from "../src/sandbox.ts";

// Apple's developer tool shims in /usr/bin look up their tool through xcrun's cache in the user's
// own temporary folder, which the sandbox closes. Each call then printed "couldn't create cache file
// … (errno=Operation not permitted)" twice, on every runtime (#1219). Apple's shims exist only on
// macOS, so this runs there, in the real Seatbelt sandbox.
const enabled = process.platform === "darwin" && existsSync("/usr/bin/xcrun");

const root = realpathSync(mkdtempSync(join(tmpdir(), "hobbots-sandbox-xcrun-")));
const project = join(root, "project");
const data = join(root, "data");
const runtimes = join(root, "runtimes");
for (const dir of [project, data, runtimes]) mkdirSync(dir);
afterAll(() => rmSync(root, { recursive: true, force: true }));

const exec = (command: string, args: ReadonlyArray<string>, env: NodeJS.ProcessEnv) =>
  Effect.callback<{ readonly code: number; readonly stdout: string; readonly stderr: string }>((resume) => {
    execFile(command, [...args], { cwd: project, env, encoding: "utf8", timeout: 20_000 }, (error, stdout, stderr) =>
      resume(Effect.succeed({ code: typeof error?.code === "number" ? error.code : 0, stdout, stderr })),
    );
  });

describe("the process sandbox and Apple's developer tool shims", () => {
  // covers PE-005, #1219
  it.runIf(enabled)("[TC-RT-1219-02] runs /usr/bin/git and /usr/bin/python3 without xcrun's cache error", async () => {
    await Effect.gen(function* () {
      const env = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" };
      // Outside the sandbox, so xcrun's cache holds both tools, as it does once the user ran them.
      for (const tool of ["git", "python3"]) yield* exec(`/usr/bin/${tool}`, ["--version"], env);

      const sandbox = yield* ProcessSandbox;
      expect(sandbox.state, sandbox.evidence).toBe("on");
      const prepared = yield* sandbox.prepare({
        folders: [project],
        folderAccess: { read: true, write: true },
        dataFolder: data,
        binary: "/bin/sh",
        runtimeFolder: join(runtimes, "hob-1"),
        allowedHosts: [],
      });
      try {
        for (const tool of ["git", "python3"]) {
          const wrapped = prepared.spawnArgs("/bin/sh", ["-c", `/usr/bin/${tool} --version`], env);
          const result = yield* exec(wrapped.command, wrapped.args, wrapped.env);
          expect(result.code, result.stderr).toBe(0);
          expect(`${result.stdout}${result.stderr}`).toMatch(/version|Python/);
          expect(result.stderr).not.toContain("xcrun_db");
        }
        // The cache stays closed for writing, so no hob can point the user's own tools elsewhere.
        const wrapped = prepared.spawnArgs(
          "/bin/sh",
          ["-c", 'printf x > "$(getconf DARWIN_USER_TEMP_DIR)xcrun_db-hobbots-test"; echo wrote=$?'],
          env,
        );
        const write = yield* exec(wrapped.command, wrapped.args, wrapped.env);
        expect(write.stdout).toMatch(/wrote=[1-9]/);
      } finally {
        prepared.release();
      }
    }).pipe(Effect.provide(ProcessSandbox.layer), Effect.scoped, Effect.runPromise);
  });
});
