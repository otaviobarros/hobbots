import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterAll, describe, expect, it } from "vitest";
import { codexCaBundle } from "../src/codex/locate.ts";
import { sandboxedCommand } from "../src/codex/turn.ts";
import { ProcessSandbox } from "../src/sandbox.ts";

const temp = realpathSync(mkdtempSync(join(tmpdir(), "hobbots-codex-ca-")));
afterAll(() => rmSync(temp, { recursive: true, force: true }));

describe("codexCaBundle", () => {
  const present = () => true;

  it("uses the user's own CODEX_CA_CERTIFICATE first, then SSL_CERT_FILE", () => {
    expect(
      codexCaBundle({ CODEX_CA_CERTIFICATE: "/ca/codex.pem", SSL_CERT_FILE: "/ca/ssl.pem" }, "darwin", present),
    ).toBe("/ca/codex.pem");
    expect(codexCaBundle({ SSL_CERT_FILE: "/ca/ssl.pem" }, "linux", present)).toBe("/ca/ssl.pem");
  });

  it("treats an empty or relative value as unset, as Codex does with an empty one", () => {
    expect(codexCaBundle({ CODEX_CA_CERTIFICATE: "", SSL_CERT_FILE: "/ca/ssl.pem" }, "linux", present)).toBe(
      "/ca/ssl.pem",
    );
    expect(codexCaBundle({ SSL_CERT_FILE: "ssl.pem" }, "linux", present)).toBeUndefined();
  });

  it("falls back to macOS's system bundle, and to none elsewhere", () => {
    expect(codexCaBundle({}, "darwin", present)).toBe("/etc/ssl/cert.pem");
    expect(codexCaBundle({}, "darwin", () => false)).toBeUndefined();
    expect(codexCaBundle({}, "linux", present)).toBeUndefined();
  });
});

/** The real sandbox: on macOS, or on Linux with HOBBOTS_SANDBOX_TESTS=1 and bubblewrap. */
const realSandbox = process.platform === "darwin" || process.env.HOBBOTS_SANDBOX_TESTS === "1";

describe.runIf(realSandbox)("Codex's CA bundle in the real sandbox", () => {
  // covers RT-001, ADR 014, ADR 024
  it("[TC-RT-106] gives the command that starts Codex its CA bundle, readable inside the sandbox", async () => {
    const root = realpathSync(mkdtempSync(join(temp, "ca-")));
    const project = join(root, "project");
    mkdirSync(project);
    const bundle = join(root, "bundle.pem");
    writeFileSync(bundle, "-----BEGIN CERTIFICATE-----\n");
    await Effect.gen(function* () {
      const sandbox = yield* ProcessSandbox;
      const prepared = yield* sandbox.prepare({
        folders: [project],
        folderAccess: { read: true, write: true },
        dataFolder: join(root, "data"),
        binary: "/bin/sh",
        runtimeFolder: join(root, "runtimes", "hob-1"),
        runtimeFiles: [bundle],
        allowedHosts: [],
      });
      try {
        // Codex's command as a turn builds it, with a shell in Codex's place.
        const launch = sandboxedCommand(
          {
            command: "/bin/sh",
            args: ["-c", 'echo "$CODEX_CA_CERTIFICATE"; head -n 1 "$CODEX_CA_CERTIFICATE"'],
            env: { PATH: "/usr/bin:/bin", CODEX_HOME: join(root, "codex"), CODEX_CA_CERTIFICATE: bundle },
            cwd: project,
          },
          prepared,
          undefined,
        );
        const ran = spawnSync(launch.command, [...launch.args], { cwd: project, env: launch.env, encoding: "utf8" });
        expect(ran.status, ran.stderr).toBe(0);
        expect(ran.stdout.trim().split("\n")).toEqual([bundle, "-----BEGIN CERTIFICATE-----"]);
      } finally {
        prepared.release();
      }
    }).pipe(Effect.provide(ProcessSandbox.layer), Effect.scoped, Effect.runPromise);
  }, 30_000);
});
