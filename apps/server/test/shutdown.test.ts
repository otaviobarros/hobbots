import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { Agent, get, request } from "node:http";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const server = resolve(import.meta.dirname, "..");

const freePort = () =>
  new Promise<number>((done, fail) => {
    const probe = createServer().once("error", fail);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => (typeof address === "object" && address ? done(address.port) : fail(new Error("No port"))));
    });
  });

const waitForHealth = async (url: string, hub: ChildProcess) => {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (hub.exitCode !== null) throw new Error(`The hub exited with ${hub.exitCode}`);
    const ok = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1000) }).then(
      (response) => response.ok,
      () => false,
    );
    if (ok) return;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(`The hub did not answer on ${url} within 30s`);
};

let hub: ChildProcess | undefined;
let dataDir: string | undefined;

afterEach(() => {
  hub?.kill("SIGKILL");
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  hub = dataDir = undefined;
});

describe("hub shutdown", () => {
  // covers DP-001
  it("[TC-DP-032] stops at once while a browser holds connections open", { timeout: 60_000 }, async () => {
    const port = await freePort();
    dataDir = mkdtempSync(join(tmpdir(), "hobbots-shutdown-"));
    const child = spawn(join(server, "node_modules", ".bin", "tsx"), ["src/main.ts"], {
      cwd: server,
      env: { ...process.env, HOBBOTS_PORT: String(port), HOBBOTS_DATA_DIR: dataDir, HOBBOTS_RUNTIME: "fake" },
      stdio: "ignore",
    });
    hub = child;
    const url = `http://127.0.0.1:${port}`;
    await waitForHealth(url, child);

    // A browser window's subscription: the hub holds the request open until it ends the stream.
    const ended = new Promise<void>((done, fail) => {
      const subscription = request(`${url}/api/events`, { headers: { accept: "text/event-stream" } }, (response) => {
        response.resume();
        response.once("end", () => done());
      });
      subscription.once("error", fail);
      subscription.end();
    });
    // A connection kept alive after its request, and a spare one that never sends a request, as
    // a browser keeps both.
    const agent = new Agent({ keepAlive: true });
    await new Promise<void>((done, fail) =>
      get(`${url}/api/health`, { agent }, (response) => response.resume().once("end", done)).once("error", fail),
    );
    const spare = connect(port, "127.0.0.1");
    await new Promise((done) => spare.once("connect", done));
    // Leaves the subscription time to reach the stream before the hub is asked to stop.
    await new Promise((done) => setTimeout(done, 500));

    const exited = new Promise<number | null>((done) => child.once("exit", (code) => done(code)));
    const stopping = performance.now();
    child.kill("SIGTERM");
    await ended;
    await exited;
    agent.destroy();
    spare.destroy();
    // The HTTP server's graceful shutdown would otherwise wait 20 seconds for these connections.
    expect(performance.now() - stopping).toBeLessThan(2000);
  });
});
