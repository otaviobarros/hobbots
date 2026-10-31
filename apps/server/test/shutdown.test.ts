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

/** Starts the hub from source on a free port and an empty data folder. */
const startHub = async () => {
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
  return { port, url, child };
};

afterEach(() => {
  hub?.kill("SIGKILL");
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  hub = dataDir = undefined;
});

describe("hub shutdown", () => {
  // covers DP-001
  it("[TC-DP-032] stops at once while a browser holds connections open", { timeout: 60_000 }, async () => {
    const { port, url, child } = await startHub();

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

  // covers DP-001
  it.each([
    ["a request whose body is still arriving", {}],
    ["one sent with Expect: 100-continue", { expect: "100-continue" }],
  ])("[TC-DP-033] lets %s finish while the hub stops", { timeout: 60_000 }, async (_, headers) => {
    const { url, child } = await startHub();
    const body = JSON.stringify({ completed: true });
    const half = Math.floor(body.length / 2);

    let started: () => void = () => {};
    const sending = new Promise<void>((done) => (started = done));
    const call = request(`${url}/api/setup`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "content-length": String(body.length), ...headers },
    });
    const answered = new Promise<number | undefined>((done, fail) => {
      call.once("response", (response) => {
        response.resume();
        done(response.statusCode);
      });
      call.once("error", fail);
    });
    if ("expect" in headers) call.once("continue", () => call.write(body.slice(0, half), () => started()));
    else call.write(body.slice(0, half), () => started());
    await sending;
    // Leaves the first half time to reach the hub before it is asked to stop.
    await new Promise((done) => setTimeout(done, 300));

    const exited = new Promise((done) => child.once("exit", done));
    child.kill("SIGTERM");
    await new Promise((done) => setTimeout(done, 300));
    call.end(body.slice(half));
    expect(await answered).toBe(200);
    await exited;
  });
});
