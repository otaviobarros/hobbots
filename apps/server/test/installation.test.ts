import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ensureInstallationId,
  installationIdFile,
  parseServerIdentity,
  readInstallationId,
} from "../src/installation.ts";

let dataDir: string;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "hobbots-installation-"));
});
afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

describe("the installation ID", () => {
  it("is created on first start and kept afterwards", () => {
    expect(readInstallationId(dataDir)).toBeUndefined();
    const id = ensureInstallationId(dataDir);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(ensureInstallationId(dataDir)).toBe(id);
    expect(readInstallationId(dataDir)).toBe(id);
    expect(readFileSync(installationIdFile(dataDir), "utf8").trim()).toBe(id);
  });

  it("keeps an ID written by another server", () => {
    writeFileSync(installationIdFile(dataDir), "existing-id\n");
    expect(ensureInstallationId(dataDir)).toBe("existing-id");
  });
});

describe("a server identity", () => {
  it("is read from a health response and nothing else", () => {
    const identity = { app: "hobbots", installationId: "id", version: "0.1.0", dataDir: "/data" };
    expect(parseServerIdentity(identity)).toEqual(identity);
    expect(parseServerIdentity({ ...identity, app: "other" })).toBeUndefined();
    expect(parseServerIdentity({ ...identity, installationId: "" })).toBeUndefined();
    expect(parseServerIdentity({ status: "ok" })).toBeUndefined();
    expect(parseServerIdentity(undefined)).toBeUndefined();
  });
});
