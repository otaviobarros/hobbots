import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { Agent, get, request } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hubPresenceFile, readHubPresence } from "../src/hub-presence.ts";
import { type HubProcess, killHubProcesses, startHubProcess } from "./hub-process.ts";

const server = resolve(import.meta.dirname, "..");

let hub: HubProcess | undefined;
let dataDir: string | undefined;

/** Starts the hub from source on a free port and an empty data folder. */
const startHub = async () => {
  dataDir = mkdtempSync(join(tmpdir(), "hobbots-shutdown-"));
  // The hub's Debug lines say when it has a request and when it starts to stop.
  hub = await startHubProcess(dataDir, { HOBBOTS_LOG_LEVEL: "Debug" });
  // As the hub's window, with the key this start of the hub wrote (ADR 021).
  return { ...hub, asWindow: hub.asWindow() };
};

afterEach(async () => {
  await killHubProcesses();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  hub = dataDir = undefined;
});

describe("hub shutdown", () => {
  // covers DP-001
  it("[TC-DP-032] stops at once while a browser holds connections open", { timeout: 60_000 }, async () => {
    const { port, url, child, asWindow } = await startHub();

    // A browser window's subscription: the hub holds the request open until it ends the stream.
    let subscribed: () => void = () => {};
    const streaming = new Promise<void>((done) => (subscribed = done));
    const ended = new Promise<void>((done, fail) => {
      const subscription = request(
        `${url}/api/events`,
        { headers: { accept: "text/event-stream", ...asWindow } },
        (response) => {
          expect(response.statusCode).toBe(200);
          subscribed();
          response.resume();
          response.once("end", () => done());
        },
      );
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
    // The subscription has reached the stream before the hub is asked to stop.
    await streaming;

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
    const { url, child, logged, asWindow } = await startHub();
    const body = JSON.stringify({ completed: true });
    const half = Math.floor(body.length / 2);

    let started: () => void = () => {};
    const sending = new Promise<void>((done) => (started = done));
    const call = request(`${url}/api/setup`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "content-length": String(body.length), ...asWindow, ...headers },
    });
    const answered = new Promise<number | undefined>((done, fail) => {
      call.once("response", (response) => {
        response.resume();
        done(response.statusCode);
      });
      call.once("error", fail);
    });
    // Handled now, so a failure is this test's, not an unhandled rejection; it is awaited below.
    answered.catch(() => {});
    if ("expect" in headers) call.once("continue", () => call.write(body.slice(0, half), () => started()));
    else call.write(body.slice(0, half), () => started());
    await sending;
    // The hub has the request before it is asked to stop.
    await logged("the hub to receive the request", /Received HTTP request \{[^}]*PATCH/);

    const exited = new Promise((done) => child.once("exit", done));
    child.kill("SIGTERM");
    // The rest of the body arrives once the hub is stopping, with the request still in progress.
    await logged("the hub to start stopping", /Stopping; HTTP requests in progress: 1/);
    call.end(body.slice(half));
    expect(await answered).toBe(200);
    await exited;
  });
});

/** Runs a command-line tool of the hub on `dataDir` in a shell without HOBBOTS_PORT, as #999 did. */
const command = (script: string, folder: string, args: ReadonlyArray<string> = []) =>
  new Promise<{ code: number; output: string }>((done) => {
    const { HOBBOTS_PORT: _port, ...env } = process.env;
    execFile(
      join(server, "node_modules", ".bin", "tsx"),
      [`src/${script}.ts`, ...args],
      { cwd: server, env: { ...env, HOBBOTS_DATA_DIR: folder } },
      (error, stdout, stderr) => done({ code: error === null ? 0 : Number(error.code ?? 1), output: stdout + stderr }),
    );
  });

describe("the command-line tools and a running hub", () => {
  // covers OP-003 (#999)
  it("[TC-OP-108] reset and restore refuse a hub on a port only it knows, and go ahead once it stops", {
    timeout: 90_000,
  }, async () => {
    const { port, child } = await startHub();
    const folder = dataDir as string;
    // tsx runs the hub in a child process of its own, so the record names that process.
    const presence = readHubPresence(folder);
    expect(presence?.port).toBe(port);
    const before = readdirSync(folder);

    const reset = await command("reset-command", folder, ["--yes"]);
    expect(reset.code).toBe(1);
    expect(reset.output).toContain(`A hub is using ${folder} (process ${presence?.pid}, port ${port})`);
    expect(reset.output).toContain("Nothing changed.");
    const restore = await command("restore-command", folder, [join(folder, "no-backup"), "--yes"]);
    expect(restore.code).toBe(1);
    expect(restore.output).toContain(`A hub is using ${folder}`);
    // The running hub may add files of its own meanwhile, but nothing it had is gone.
    expect(readdirSync(folder)).toEqual(expect.arrayContaining(before));

    const exited = new Promise((done) => child.once("exit", done));
    child.kill("SIGTERM");
    await exited;
    expect(existsSync(hubPresenceFile(folder))).toBe(false);
    // Without --yes the command only says what it would delete.
    const after = await command("reset-command", folder);
    expect(after.code).toBe(0);
    expect(after.output).toContain("Run again with --yes to delete everything.");
  });

  // covers OP-003 (#999)
  it("[TC-OP-112] a second hub on the same data folder does not start, and leaves the first one's record", {
    timeout: 90_000,
  }, async () => {
    const { port } = await startHub();
    const folder = dataDir as string;
    const first = readHubPresence(folder);
    // The second hub stops before it ever answers, and says why.
    const refused = await startHubProcess(folder).then(
      () => "",
      (error: unknown) => String(error),
    );
    expect(refused).toContain("The hub exited with 1");
    expect(refused).toContain(`Another hub (process ${first?.pid}, port ${port}) is using ${folder}`);
    expect(readHubPresence(folder)).toEqual(first);
    const reset = await command("reset-command", folder, ["--yes"]);
    expect(reset.code).toBe(1);
    expect(reset.output).toContain(`(process ${first?.pid}, port ${port})`);
  });
});
