import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ProcessSandbox } from "../src/sandbox.ts";

// A hob's commands run in the real OS sandbox (Seatbelt on macOS, bubblewrap on Linux) and must
// never reach the hub's own API, whatever headers they forge (PE-006, ADR 014, ADR 015). The rest of
// the sandbox's cases run on macOS only; on Linux these run with HOBBOTS_SANDBOX_TESTS=1 where
// bubblewrap, socat and sandbox-runtime's seccomp helper are installed.
const enabled = process.platform === "darwin" || process.env.HOBBOTS_SANDBOX_TESTS === "1";

const root = realpathSync(mkdtempSync(join(tmpdir(), "hobbots-sandbox-hub-")));
const project = join(root, "project");
const data = join(root, "data");
const runtimes = join(root, "runtimes");
for (const dir of [project, data, runtimes]) mkdirSync(dir);

// Stands in for the hub: it counts every request that reaches it, on IPv4 and IPv6 loopback.
const reached: Array<string> = [];
const servers: Array<Server> = [];
let port = 0;
const listen = (host: string, at: number) =>
  new Promise<Server>((resolve, reject) => {
    const server = createServer((request, response) => {
      reached.push(`${request.method} ${request.url} from ${request.headers.origin ?? "no origin"}`);
      response.writeHead(200, { "content-type": "application/json" }).end('{"state":"approved"}');
    });
    server.once("error", reject);
    server.listen({ host, port: at, ipv6Only: host === "::1" }, () => resolve(server));
  });

beforeAll(async () => {
  const v4 = await listen("127.0.0.1", 0);
  servers.push(v4);
  port = (v4.address() as AddressInfo).port;
  // A host without IPv6 loopback still checks IPv4.
  await listen("::1", port).then(
    (v6) => servers.push(v6),
    () => undefined,
  );
});
afterAll(async () => {
  await Promise.all(servers.map((server) => new Promise((done) => server.close(done))));
  rmSync(root, { recursive: true, force: true });
});

/**
 * Runs a process without blocking, so the stand-in hub in this process can answer it, and reports
 * what it printed whether or not it succeeded.
 */
const exec = (
  command: string,
  args: ReadonlyArray<string>,
  options: { readonly cwd?: string; readonly env: NodeJS.ProcessEnv },
) =>
  Effect.callback<{ readonly stdout: string; readonly stderr: string }>((resume) => {
    execFile(command, [...args], { ...options, encoding: "utf8", timeout: 20_000 }, (_, stdout, stderr) =>
      resume(Effect.succeed({ stdout, stderr })),
    );
  });

describe("the process sandbox and the hub", () => {
  // covers PE-006, PE-005
  it.runIf(enabled)(
    "[TC-PE-114] a sandboxed command never reaches the hub's API, even with a forged Origin and every host allowed",
    async () => {
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
          // The widest a turn can be: every host the proxy asks about is allowed.
          decideHost: async () => true,
        });
        try {
          const run = (script: string) => {
            const { command, args, env } = prepared.spawnArgs("/bin/sh", ["-c", script], {
              PATH: "/usr/bin:/bin",
            });
            return exec(command, args, { cwd: project, env });
          };
          const forged = (url: string, extra = "") =>
            `curl -sS --max-time 5 ${extra} -X POST -H 'Origin: http://127.0.0.1:${port}' ` +
            `-H 'content-type: application/json' -d '{"decision":"approve","actionDigest":"x","lifetime":"always"}' ${url}`;
          const attempts = [
            // Through the sandbox's proxy, as any command's traffic goes.
            forged(`http://127.0.0.1:${port}/api/approvals/a1/decision`),
            forged(`http://localhost:${port}/api/grants/g1/revoke`),
            forged(`http://[::1]:${port}/api/approvals/a1/decision`),
            forged(`http://127.1:${port}/api/approvals/a1/decision`),
            // Around the proxy, straight to the address.
            forged(`http://127.0.0.1:${port}/api/approvals/a1/decision`, "--noproxy '*'"),
            forged(`http://[::1]:${port}/api/approvals/a1/decision`, "--noproxy '*'"),
            `env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy -u ALL_PROXY -u all_proxy ${forged(
              `http://localhost:${port}/api/setup`,
            )}`,
            // A raw connection with no HTTP client at all.
            `bash -c 'exec 3<>/dev/tcp/127.0.0.1/${port} && printf "POST /api/approvals/a1/decision HTTP/1.1\\r\\nHost: 127.0.0.1\\r\\n\\r\\n" >&3 && cat <&3'`,
          ];
          // Commands do run in the sandbox, so a refusal below is the network rules', not a sandbox that never started.
          expect((yield* run("echo ran")).stdout.trim()).toBe("ran");
          // Outside the sandbox the same request reaches it, so what follows is the sandbox's doing.
          const control = yield* exec("/bin/sh", ["-c", forged(`http://127.0.0.1:${port}/api/approvals/a1/decision`)], {
            env: { PATH: "/usr/bin:/bin" },
          });
          expect(control.stdout).toContain('"state":"approved"');
          expect(reached).toHaveLength(1);
          reached.length = 0;

          for (const attempt of attempts) {
            const result = yield* run(attempt);
            expect(result.stdout, attempt).not.toContain('"state":"approved"');
          }
          // Nothing reached the hub, so nothing was decided, granted or revoked.
          expect(reached).toEqual([]);
        } finally {
          prepared.release();
        }
      }).pipe(Effect.provide(ProcessSandbox.layer), Effect.scoped, Effect.runPromise);
    },
    120_000,
  );
});
