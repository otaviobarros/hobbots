import { type ChildProcess, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { waitFor } from "@hobbots/domain/testing";
import { Effect } from "effect";

// The hub as a user runs it: `main.ts` from source in its own process, on a free port and a data
// folder of the test's, with the fake runtime unless `env` says otherwise.

const server = resolve(import.meta.dirname, "..");

export const freePort = () =>
  new Promise<number>((done, fail) => {
    const probe = createServer().once("error", fail);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => (typeof address === "object" && address ? done(address.port) : fail(new Error("No port"))));
    });
  });

export interface HubProcess {
  readonly port: number;
  readonly url: string;
  readonly child: ChildProcess;
  /** Everything the hub has written so far. */
  readonly output: () => string;
  /** Waits until the hub has written a line that matches `line`. */
  readonly logged: (what: string, line: RegExp) => Promise<void>;
  /** Headers that make a request the hub's window's, with the key the hub wrote when it last started. */
  readonly asWindow: () => Record<string, string>;
  /** Waits until the hub answers its health check again, as after it restarts itself for a restore. */
  readonly answers: () => Promise<void>;
  /** Asks the hub to stop and waits for it to exit. */
  readonly stop: () => Promise<void>;
}

const healthy = (url: string) =>
  fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1000) }).then(
    (response) => response.ok,
    () => false,
  );

/** Starts the hub on `dataDir` and waits until it answers. Pass `port` to start it again where it was. */
export const startHubProcess = async (
  dataDir: string,
  env: Record<string, string | undefined> = {},
  port?: number,
): Promise<HubProcess> => {
  const listening = port ?? (await freePort());
  const child = spawn(join(server, "node_modules", ".bin", "tsx"), ["src/main.ts"], {
    cwd: server,
    env: {
      ...process.env,
      HOBBOTS_PORT: String(listening),
      HOBBOTS_DATA_DIR: dataDir,
      HOBBOTS_RUNTIME: "fake",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const collect = (chunk: Buffer) => {
    output += chunk.toString("utf8");
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  const url = `http://127.0.0.1:${listening}`;
  const answers = async () => {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`The hub exited with ${child.exitCode}:\n${output}`);
      if (await healthy(url)) return;
      await new Promise((done) => setTimeout(done, 100));
    }
    throw new Error(`The hub did not answer on ${url} within 60s:\n${output}`);
  };
  await answers();
  return {
    port: listening,
    url,
    child,
    output: () => output,
    logged: (what, line) => Effect.runPromise(waitFor(what, () => line.test(output))),
    asWindow: () => ({ authorization: `Bearer ${readFileSync(join(dataDir, "window-key"), "utf8").trim()}` }),
    answers,
    stop: () =>
      new Promise<void>((done) => {
        if (child.exitCode !== null || child.signalCode !== null) return done();
        child.once("exit", () => done());
        child.kill("SIGTERM");
      }),
  };
};
