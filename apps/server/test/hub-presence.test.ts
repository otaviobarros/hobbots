import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hubUsing } from "../src/command-line.ts";
import {
  claimHubPresence,
  forgetHubPresence,
  hubPresenceFile,
  readHubPresence,
  recordHubPort,
} from "../src/hub-presence.ts";
import { ensureInstallationId } from "../src/installation.ts";

// How the command-line tools tell whether a hub is using a data folder (#999). They refuse whenever
// they cannot tell, because a reset cannot be undone.

let dataDir: string;
let server: Server | undefined;
const savedPort = process.env.HOBBOTS_PORT;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "hobbots-presence-"));
});

afterEach(async () => {
  await stop();
  rmSync(dataDir, { recursive: true, force: true });
  if (savedPort === undefined) delete process.env.HOBBOTS_PORT;
  else process.env.HOBBOTS_PORT = savedPort;
});

/** Listens on a free port with `handler`, and points the check at it as the hub's port. */
const listen = async (handler: Parameters<typeof createServer>[1]) => {
  const listening = createServer(handler);
  server = listening;
  await new Promise<void>((done) => listening.listen(0, "127.0.0.1", done));
  const address = listening.address();
  if (typeof address !== "object" || address === null) throw new Error("No port");
  process.env.HOBBOTS_PORT = String(address.port);
  return address.port;
};

/** Stops the server `listen` started, ending any connection it left open. */
const stop = async () => {
  server?.closeAllConnections();
  await new Promise((done) => (server ? server.close(done) : done(undefined)));
  server = undefined;
};

/** A port nothing listens on: one that was free a moment ago. */
const closedPort = async () => {
  const port = await listen(() => undefined);
  await new Promise((done) => server?.close(done));
  server = undefined;
  return port;
};

const health = (installationId: string) =>
  JSON.stringify({ app: "hobbots", installationId, version: "test", dataDir: "/elsewhere" });

describe("whether a hub is using a data folder", () => {
  // covers OP-003 (#999)
  it("[TC-OP-109] trusts a live record, sees past a stale one, and refuses a port that does not answer", async () => {
    // A hub's record of a live process counts, whatever port it names.
    writeFileSync(hubPresenceFile(dataDir), JSON.stringify({ pid: process.pid, port: 4393 }));
    await closedPort();
    expect(await Effect.runPromise(hubUsing(dataDir))).toContain(`process ${process.pid}, port 4393`);

    // The record of a hub that crashed names a process that is gone, so the port is asked.
    const gone = spawnSync(process.execPath, ["-e", "process.pid"]).pid;
    writeFileSync(hubPresenceFile(dataDir), JSON.stringify({ pid: gone, port: 4393 }));
    expect(await Effect.runPromise(hubUsing(dataDir))).toBeUndefined();

    // A hub of this folder that keeps no record, such as one of an earlier version, answers.
    rmSync(hubPresenceFile(dataDir));
    const id = ensureInstallationId(dataDir);
    await listen((_, response) => response.end(health(id)));
    expect(await Effect.runPromise(hubUsing(dataDir))).toContain(`A hub is using ${dataDir}`);
  });

  it("[TC-OP-110] counts only another installation's whole answer as no hub, and refuses a slow, partial or unknown one", {
    timeout: 30_000,
  }, async () => {
    ensureInstallationId(dataDir);
    await listen((_, response) => response.end(health("another-installation")));
    expect(await Effect.runPromise(hubUsing(dataDir))).toBeUndefined();
    await stop();

    // Nothing comes back at all.
    let port = await listen(() => undefined);
    expect(await Effect.runPromise(hubUsing(dataDir))).toBe(
      `Port ${port} did not answer in full, so a hub may be using ${dataDir}.`,
    );
    await stop();

    // The headers come back, then the body stalls.
    port = await listen((_, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"app":"hob');
    });
    expect(await Effect.runPromise(hubUsing(dataDir))).toBe(
      `Port ${port} did not answer in full, so a hub may be using ${dataDir}.`,
    );
    await stop();

    // A body that is not JSON, and JSON that names no hub.
    port = await listen((_, response) => response.end("<html>"));
    expect(await Effect.runPromise(hubUsing(dataDir))).toBe(
      `Port ${port} did not answer in full, so a hub may be using ${dataDir}.`,
    );
    await stop();
    port = await listen((_, response) => response.end(JSON.stringify({ status: "ok" })));
    expect(await Effect.runPromise(hubUsing(dataDir))).toBe(
      `Port ${port} did not say which hub it is, so a hub may be using ${dataDir}.`,
    );
  });
});

describe("a hub's record of itself", () => {
  // covers OP-003 (#999)
  it("[TC-OP-111] a second hub cannot take a live hub's record, and only the hub that holds it updates or removes it", async () => {
    const other = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"]);
    try {
      writeFileSync(hubPresenceFile(dataDir), JSON.stringify({ pid: other.pid, port: 4393 }));
      const claimed = await Effect.runPromise(Effect.flip(claimHubPresence(dataDir, 4317)));
      expect(claimed).toMatchObject({ _tag: "HubAlreadyRunning", pid: other.pid, port: 4393 });
      await Effect.runPromise(recordHubPort(dataDir, 4317));
      await Effect.runPromise(forgetHubPresence(dataDir));
      expect(readHubPresence(dataDir)).toEqual({ pid: other.pid, port: 4393 });
    } finally {
      other.kill("SIGKILL");
    }
    await new Promise((done) =>
      other.exitCode === null && other.signalCode === null ? other.once("exit", done) : done(undefined),
    );

    // Once that process is gone its record is stale, and this one takes the folder.
    await Effect.runPromise(claimHubPresence(dataDir, 4317));
    expect(readHubPresence(dataDir)).toEqual({ pid: process.pid, port: 4317 });
    await Effect.runPromise(recordHubPort(dataDir, 4400));
    expect(readHubPresence(dataDir)).toEqual({ pid: process.pid, port: 4400 });
    await Effect.runPromise(forgetHubPresence(dataDir));
    expect(readHubPresence(dataDir)).toBeUndefined();

    // With no record at all, the first claim makes one.
    await Effect.runPromise(claimHubPresence(dataDir, 4317));
    expect(readHubPresence(dataDir)).toEqual({ pid: process.pid, port: 4317 });
  });
});
