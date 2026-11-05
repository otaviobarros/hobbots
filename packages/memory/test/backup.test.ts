import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Redacted } from "effect";
import { create } from "tar";
import { afterEach, describe, expect, it } from "vitest";
import { checkMemoryArchive, packStoppedMemory, restoreMemoryArchive } from "../src/engine/backup.ts";
import { NO_MODEL, renderEngineConfig } from "../src/engine/config.ts";
import type { MemoryKeys } from "../src/engine/keys.ts";

// Memory in a backup (ADR 028): the archive is checked before it is kept or unpacked, holds no
// memory bearer, and comes back owner-only.

const folders: Array<string> = [];
const tempFolder = (prefix: string) => {
  const folder = mkdtempSync(join(tmpdir(), prefix));
  folders.push(folder);
  return folder;
};
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

const keys: MemoryKeys = {
  root: Redacted.make("1".repeat(64)),
  proxy: Redacted.make("2".repeat(64)),
  model: Redacted.make("3".repeat(64)),
};

/** An engine's data folder as a stopped engine leaves it: a wiki with Git, a database, logs and the hub's config. */
const memoryFolder = (files: Record<string, string> = {}) => {
  const memory = tempFolder("hobbots-memory-");
  const write = (path: string, text: string) => {
    mkdirSync(join(memory, path, ".."), { recursive: true });
    writeFileSync(join(memory, path), text);
  };
  write("wiki/hobbots/hob-pip/notes/tests.md", "# Tests\n\nRun pnpm check.");
  write("wiki/.git/HEAD", "ref: refs/heads/master\n");
  write("db/memory.sqlite", "SQLite format 3\u0000");
  write("logs/ai-memory.log", "started");
  write("config.toml", renderEngineConfig(NO_MODEL, null));
  for (const [path, text] of Object.entries(files)) write(path, text);
  return memory;
};

/** Packs `entries` of `folder` as they are, links included, as a damaged or crafted archive would be. */
const archiveOf = async (folder: string, entries: ReadonlyArray<string>) => {
  const file = join(tempFolder("hobbots-archive-"), "memory.tar.gz");
  await create({ file, cwd: folder, gzip: true }, [...entries]);
  return file;
};

const refusal = async (file: string, withKeys: MemoryKeys | undefined = keys) => {
  const exit = await Effect.runPromise(Effect.flip(checkMemoryArchive(file, withKeys)));
  return exit.reason;
};

describe("memory archives", () => {
  // covers ADR 028 (Backups), OP-003
  it("[TC-OP-095] packs a stopped engine's memory without its logs, and restores it owner-only", async () => {
    const memory = memoryFolder();
    const target = join(tempFolder("hobbots-backup-"), "ai-memory.tar.gz");
    expect(await Effect.runPromise(packStoppedMemory(memory, target, keys))).toBe(true);
    expect(statSync(target).mode & 0o777).toBe(0o600);

    const restored = join(tempFolder("hobbots-restored-"), "memory");
    await Effect.runPromise(restoreMemoryArchive(target, restored));
    expect(readFileSync(join(restored, "wiki/hobbots/hob-pip/notes/tests.md"), "utf8")).toBe(
      "# Tests\n\nRun pnpm check.",
    );
    expect(readFileSync(join(restored, "wiki/.git/HEAD"), "utf8")).toBe("ref: refs/heads/master\n");
    expect(readFileSync(join(restored, "db/memory.sqlite"), "utf8")).toBe("SQLite format 3\u0000");
    expect(() => statSync(join(restored, "logs"))).toThrow();
    for (const path of ["", "wiki", "db", "db/memory.sqlite", "config.toml"]) {
      expect(statSync(join(restored, path)).mode & 0o077, path).toBe(0);
    }

    // An engine that never kept anything has nothing to pack.
    const empty = tempFolder("hobbots-memory-");
    const none = join(tempFolder("hobbots-backup-"), "ai-memory.tar.gz");
    expect(await Effect.runPromise(packStoppedMemory(empty, none, keys))).toBe(false);
    expect(() => statSync(none)).toThrow();
  });

  // covers ADR 028 (Backups), OP-003
  it("[TC-OP-096] refuses an archive with a memory bearer, a credential in its config, a link or anything else", async () => {
    const clean = memoryFolder();
    expect(
      await Effect.runPromise(checkMemoryArchive(await archiveOf(clean, ["wiki", "db", "config.toml"]), keys)),
    ).toBe(undefined);

    const bearerInConfig = memoryFolder({ "config.toml": `[auth]\nbearer_token = "${Redacted.value(keys.root)}"\n` });
    expect(await refusal(await archiveOf(bearerInConfig, ["wiki", "config.toml"]))).toMatch(
      /config\.toml holds a memory bearer; config\.toml holds a credential/,
    );
    // A credential setting is refused whatever its value.
    const pepper = memoryFolder({ "config.toml": '[auth]\ntoken_pepper = "anything"\n' });
    expect(await refusal(await archiveOf(pepper, ["wiki", "config.toml"]))).toMatch(/config\.toml holds a credential/);
    // With no keys known, as a migration backup without memory-keys and every restore check it.
    expect(await refusal(await archiveOf(pepper, ["wiki", "config.toml"]), undefined)).toMatch(
      /config\.toml holds a credential/,
    );
    expect(await refusal(await archiveOf(bearerInConfig, ["wiki", "config.toml"]), undefined)).toMatch(
      /config\.toml holds a credential/,
    );
    const keyless = join(tempFolder("hobbots-backup-"), "ai-memory.tar.gz");
    const packed = await Effect.runPromiseExit(packStoppedMemory(pepper, keyless, undefined));
    expect(packed._tag).toBe("Failure");
    expect(() => statSync(keyless)).toThrow();
    const restoredPepper = join(tempFolder("hobbots-restored-"), "memory");
    const unpacked = await Effect.runPromiseExit(
      restoreMemoryArchive(await archiveOf(pepper, ["wiki", "config.toml"]), restoredPepper),
    );
    expect(unpacked._tag).toBe("Failure");
    expect(() => statSync(restoredPepper)).toThrow();
    // Either bearer, anywhere in the archive.
    const inAPage = memoryFolder({ "wiki/hobbots/hob-pip/notes/leak.md": `token ${Redacted.value(keys.proxy)}` });
    expect(await refusal(await archiveOf(inAPage, ["wiki"]))).toMatch(/leak\.md holds a memory bearer/);

    const linked = memoryFolder();
    symlinkSync("/etc/passwd", join(linked, "wiki", "passwd"));
    expect(await refusal(await archiveOf(linked, ["wiki"]), undefined)).toMatch(/wiki\/passwd, which is not part/);
    expect(await refusal(await archiveOf(memoryFolder(), ["wiki", "logs"]), undefined)).toMatch(/logs/);

    const notAnArchive = join(tempFolder("hobbots-archive-"), "memory.tar.gz");
    writeFileSync(notAnArchive, "not a tarball");
    expect(await refusal(notAnArchive)).toMatch(/could not be read|empty/);

    // A refused archive is never unpacked.
    const restored = join(tempFolder("hobbots-restored-"), "memory");
    const exit = await Effect.runPromiseExit(restoreMemoryArchive(await archiveOf(linked, ["wiki"]), restored));
    expect(exit._tag).toBe("Failure");
    expect(() => statSync(restored)).toThrow();
  });
});
