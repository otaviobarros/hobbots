import { mkdtempSync, rmSync } from "node:fs";
import { Agent, get, request } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type HubProcess, killHubProcesses, startHubProcess } from "./hub-process.ts";

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
