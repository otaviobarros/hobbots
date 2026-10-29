import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installationIdFile } from "@hobbots/server/installation";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { checkServer, judgeHealth, ownInstallation, requireOurs } from "../src/main/server-identity.ts";

const dataDir = mkdtempSync(join(tmpdir(), "hobbots-identity-"));
writeFileSync(installationIdFile(dataDir), "this-installation\n");
const own = ownInstallation(dataDir);
const identity = { app: "hobbots", installationId: "this-installation", version: "0.2.0", dataDir: own.dataDir };

let server: Server | undefined;
afterEach(() => new Promise<void>((done) => (server ? server.close(() => done()) : done())));
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

/** Listens on a free loopback port with a fixed answer and returns its URL. */
const answering = (status: number, body: string) =>
  new Promise<string>((done) => {
    const listening = createServer((_request, response) => response.writeHead(status).end(body));
    server = listening;
    listening.listen(0, "127.0.0.1", () => done(`http://127.0.0.1:${(listening.address() as AddressInfo).port}`));
  });

/** A loopback port nothing listens on. */
const freePort = () =>
  new Promise<string>((done) => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const url = `http://127.0.0.1:${(probe.address() as AddressInfo).port}`;
      probe.close(() => done(url));
    });
  });

describe("judging a health response", () => {
  it("accepts this installation's server whatever its version", () => {
    expect(judgeHealth(identity, own).kind).toBe("ours");
    expect(judgeHealth({ ...identity, version: "development" }, own).kind).toBe("ours");
  });

  it("refuses another installation or another data folder", () => {
    expect(judgeHealth({ ...identity, installationId: "another" }, own).kind).toBe("otherInstallation");
    expect(judgeHealth({ ...identity, dataDir: "/elsewhere" }, own).kind).toBe("otherInstallation");
    expect(judgeHealth(identity, { ...own, installationId: undefined }).kind).toBe("otherInstallation");
  });

  it("refuses anything that is not a Hobbots identity", () => {
    expect(judgeHealth(undefined, own).kind).toBe("notHobbots");
    expect(judgeHealth({ status: "ok" }, own).kind).toBe("notHobbots");
  });
});

describe("checking the port", () => {
  // covers DP-001
  it("[TC-DP-020] connects only to this installation's server", async () => {
    const check = await checkServer(await answering(200, JSON.stringify(identity)), dataDir);
    expect(check.kind).toBe("ours");
    expect(() => requireOurs(check, 4317)).not.toThrow();
  });

  // covers DP-001
  it("[TC-DP-021] reports another program on the port instead of connecting to it", async () => {
    for (const [status, body] of [
      [200, ""],
      [200, "<html>not hobbots</html>"],
      [200, JSON.stringify({ status: "ok" })],
      [404, JSON.stringify(identity)],
    ] as const) {
      const check = await checkServer(await answering(status, body), dataDir);
      expect(check.kind).toBe("notHobbots");
      expect(() => requireOurs(check, 4317)).toThrow("Another program is using port 4317");
      await new Promise<void>((done) => server?.close(() => done()));
      server = undefined;
    }
  });

  // covers DP-001
  it("[TC-DP-022] reports a server of another installation instead of connecting to it", async () => {
    const check = await checkServer(
      await answering(200, JSON.stringify({ ...identity, installationId: "x" })),
      dataDir,
    );
    expect(check.kind).toBe("otherInstallation");
    expect(() => requireOurs(check, 4317)).toThrow("Another Hobbots is using the port");
  });

  // covers DP-001
  it("[TC-DP-023] finds nothing on a free port, so the app starts its own server", async () => {
    expect((await checkServer(await freePort(), dataDir)).kind).toBe("none");
  });
});
