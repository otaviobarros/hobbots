import { type ChildProcess, spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const web = resolve(import.meta.dirname, "..");
const server = resolve(web, "../server");

/** Where test hubs keep their data: under the checkout and git-ignored, never the user's Hobbots data. */
const dataRoot = resolve(web, "../../.data/e2e");

// One port for every hub; the tests run one at a time. Set HOBBOTS_E2E_PORT beside another server.
const port = Number(process.env.HOBBOTS_E2E_PORT ?? 4380);

export interface Hub {
  /** The served web client, as the desktop app loads it. */
  readonly url: string;
  readonly dataDir: string;
  /** Stops the server and waits for it to exit; the data folder stays. */
  readonly stop: () => Promise<void>;
}

/** A new, empty data folder for one test. */
export const emptyDataDir = (): string => {
  mkdirSync(dataRoot, { recursive: true });
  return mkdtempSync(join(dataRoot, "hub-"));
};

export const removeDataDir = (dataDir: string) => rmSync(dataDir, { recursive: true, force: true });

/**
 * Starts the hub from source on `dataDir`, serving the web client's build, and waits until it
 * answers. The fake runtime is the default; `env` picks another runtime or Claude Code binary.
 * Fails when another hub answers on the port, so a test never acts on someone else's data.
 */
export const startHub = async (dataDir: string, env: Record<string, string> = {}): Promise<Hub> => {
  const child = spawn(join(server, "node_modules", ".bin", "tsx"), ["src/main.ts"], {
    cwd: server,
    env: {
      ...process.env,
      HOBBOTS_PORT: String(port),
      HOBBOTS_DATA_DIR: dataDir,
      HOBBOTS_WEB_DIR: join(web, "dist"),
      HOBBOTS_RUNTIME: "fake",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout?.on("data", (chunk) => (output += chunk));
  child.stderr?.on("data", (chunk) => (output += chunk));

  const url = `http://127.0.0.1:${port}`;
  // The health endpoint reports the canonical data folder of the hub that answered.
  const ours = realpathSync(dataDir);
  const fail = async (problem: string) => {
    await stopProcess(child);
    throw new Error(`${problem}\n${output}`);
  };
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`The hub exited with ${child.exitCode}:\n${output}`);
    const identity = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1000) }).then(
      (response) => (response.ok ? (response.json() as Promise<{ readonly dataDir?: unknown }>) : undefined),
      () => undefined,
    );
    if (identity !== undefined) {
      if (identity.dataDir === ours) break;
      return fail(
        `Another hub (data: ${String(identity.dataDir)}) answers on ${url}; stop it or set HOBBOTS_E2E_PORT.`,
      );
    }
    if (Date.now() > deadline) return fail(`The hub did not answer on ${url} within 30s:`);
    await new Promise((done) => setTimeout(done, 200));
  }
  return { url, dataDir, stop: () => stopProcess(child) };
};

const stopProcess = (child: ChildProcess) =>
  new Promise<void>((done) => {
    if (child.exitCode !== null || child.signalCode !== null) return done();
    child.once("exit", () => done());
    child.kill("SIGTERM");
  });

/**
 * A stand-in Claude Code that is installed but signed out: it prints a version and answers the
 * Agent SDK's initialize request with an empty account, as a binary with no login does. The real
 * Claude Code adapter starts it, so the check goes through the same path as on a user's Mac.
 */
export const signedOutClaudeCode = (dataDir: string): string => {
  const path = join(dataDir, "bin", "claude");
  mkdirSync(join(dataDir, "bin"), { recursive: true });
  writeFileSync(
    path,
    `#!/usr/bin/env node
if (process.argv.includes("--version")) {
  process.stdout.write("9.9.9 (Claude Code)\\n");
  process.exit(0);
}
let buffered = "";
process.stdin.on("data", (chunk) => {
  buffered += chunk;
  for (let end = buffered.indexOf("\\n"); end >= 0; end = buffered.indexOf("\\n")) {
    const message = JSON.parse(buffered.slice(0, end));
    buffered = buffered.slice(end + 1);
    if (message.type !== "control_request") continue;
    const response = message.request.subtype === "initialize" ? { commands: [], models: [], account: {} } : {};
    const reply = { type: "control_response", response: { subtype: "success", request_id: message.request_id, response } };
    process.stdout.write(JSON.stringify(reply) + "\\n");
  }
});
`,
  );
  chmodSync(path, 0o755);
  return path;
};
