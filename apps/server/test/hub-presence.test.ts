import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hubUsing } from "../src/command-line.ts";
import { hubPresenceFile } from "../src/hub-presence.ts";
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
  await new Promise((done) => (server ? server.close(done) : done(undefined)));
  server = undefined;
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

  it("[TC-OP-110] counts another installation's hub as none, and a hub too slow to answer as one", {
    timeout: 15_000,
  }, async () => {
    ensureInstallationId(dataDir);
    await listen((_, response) => response.end(health("another-installation")));
    expect(await Effect.runPromise(hubUsing(dataDir))).toBeUndefined();

    await new Promise((done) => server?.close(done));
    const port = await listen(() => undefined);
    expect(await Effect.runPromise(hubUsing(dataDir))).toBe(
      `Port ${port} did not answer, so a hub may be using ${dataDir}.`,
    );
  });
});
