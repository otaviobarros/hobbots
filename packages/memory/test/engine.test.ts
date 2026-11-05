import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeServices } from "@effect/platform-node";
import { Effect, Layer, Option, Redacted, Schedule, type Scope } from "effect";
import { FetchHttpClient } from "effect/http";
import { create } from "tar";
import { afterEach, describe, expect, it } from "vitest";
import { ENGINE_BINARY, ENGINE_CHECKSUM, parseChecksum, parseVersion, verifyEngine } from "../src/engine/binary.ts";
import { configHoldsCredential, renderEngineConfig } from "../src/engine/config.ts";
import { MemoryEngine, type MemoryEngineOptions } from "../src/engine/engine.ts";
import { loadOrCreateMemoryKeys, memoryKeysFile } from "../src/engine/keys.ts";
import { AI_MEMORY_VERSION } from "../src/engine/release.ts";
import { standInEngine } from "./stand-in-engine.ts";

const folders: Array<string> = [];
const tempFolder = (prefix: string) => {
  const folder = mkdtempSync(join(tmpdir(), prefix));
  folders.push(folder);
  return folder;
};
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

interface Start {
  readonly pid: number;
  readonly env: Record<string, string>;
  readonly args: ReadonlyArray<string>;
}
const startsOf = (dataDir: string): ReadonlyArray<Start> => {
  const file = join(dataDir, "memory", "starts.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Start);
};
const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Runs `body` against an engine on the stand-in binary, then closes its scope. */
const withEngine = <A>(
  overrides: Partial<MemoryEngineOptions>,
  body: (engine: MemoryEngine["Service"], dataDir: string) => Effect.Effect<A, unknown, Scope.Scope>,
) =>
  Effect.gen(function* () {
    const folder = overrides.folder ?? (yield* Effect.promise(standInEngine));
    folders.push(folder);
    const dataDir = overrides.dataDir ?? tempFolder("hobbots-data-");
    const keys = loadOrCreateMemoryKeys(dataDir);
    const layer = MemoryEngine.layer({
      firstBackoff: "50 millis",
      maxBackoff: "200 millis",
      checkEvery: "100 millis",
      ...overrides,
      folder,
      dataDir,
      keys,
    }).pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)));
    return yield* Effect.gen(function* () {
      const engine = yield* MemoryEngine;
      return yield* body(engine, dataDir);
    }).pipe(Effect.provide(layer), Effect.scoped);
  }).pipe(Effect.scoped, Effect.runPromise);

/** Waits until the engine's health satisfies `ready`. */
const until = (engine: MemoryEngine["Service"], ready: (health: Effect.Success<typeof engine.health>) => boolean) =>
  engine.health.pipe(
    Effect.repeat({ schedule: Schedule.spaced("25 millis"), until: ready }),
    Effect.timeout("15 seconds"),
  );

describe("the engine's files", () => {
  it("reads a checksum line and a version line", () => {
    expect(parseChecksum(`${"a".repeat(64)}  ai-memory\n`)).toBe("a".repeat(64));
    expect(parseChecksum("a".repeat(64))).toBe("a".repeat(64));
    expect(parseChecksum("not a checksum")).toBeUndefined();
    expect(parseVersion("ai-memory 3.4.2\n")).toBe("3.4.2");
    expect(parseVersion("something else")).toBeUndefined();
  });

  it("runs only a binary that matches its checksum and the pinned version", async () => {
    const folder = await standInEngine();
    folders.push(folder);
    expect((await Effect.runPromise(verifyEngine(folder)))._tag).toBe("Verified");

    writeFileSync(join(folder, ENGINE_BINARY), `${readFileSync(join(folder, ENGINE_BINARY), "utf8")}\n// changed`);
    expect(await Effect.runPromise(verifyEngine(folder))).toMatchObject({ _tag: "Mismatch" });

    rmSync(join(folder, ENGINE_CHECKSUM));
    expect(await Effect.runPromise(verifyEngine(folder))).toMatchObject({ _tag: "Missing" });
    expect(await Effect.runPromise(verifyEngine(tempFolder("hobbots-empty-")))).toMatchObject({ _tag: "Missing" });
  });

  it("refuses a binary of another version even when its checksum matches", async () => {
    const folder = await standInEngine();
    folders.push(folder);
    const binary = join(folder, ENGINE_BINARY);
    writeFileSync(binary, readFileSync(binary, "utf8").replace(`ai-memory ${AI_MEMORY_VERSION}`, "ai-memory 0.0.1"));
    const { checksumLine, sha256File } = await import("../src/engine/binary.ts");
    writeFileSync(join(folder, ENGINE_CHECKSUM), checksumLine(await sha256File(binary)));
    expect(await Effect.runPromise(verifyEngine(folder))).toMatchObject({ _tag: "Mismatch" });
  });
});

describe("the hub's memory keys", () => {
  it("are made once, owner-only, and kept across starts", () => {
    const dataDir = tempFolder("hobbots-keys-");
    const first = loadOrCreateMemoryKeys(dataDir);
    const again = loadOrCreateMemoryKeys(dataDir);
    expect(Redacted.value(again.root)).toBe(Redacted.value(first.root));
    expect(Redacted.value(again.proxy)).toBe(Redacted.value(first.proxy));
    expect(Redacted.value(first.root)).not.toBe(Redacted.value(first.proxy));
    expect(Redacted.value(first.root)).toMatch(/^[0-9a-f]{64}$/);
    expect(statSync(memoryKeysFile(dataDir)).mode & 0o777).toBe(0o600);
  });

  it("are replaced when the file is damaged, and made owner-only again when it is not", () => {
    const dataDir = tempFolder("hobbots-keys-");
    const first = loadOrCreateMemoryKeys(dataDir);
    writeFileSync(memoryKeysFile(dataDir), "{}", { mode: 0o644 });
    const replaced = loadOrCreateMemoryKeys(dataDir);
    expect(Redacted.value(replaced.root)).not.toBe(Redacted.value(first.root));
    const { chmodSync } = require("node:fs") as typeof import("node:fs");
    chmodSync(memoryKeysFile(dataDir), 0o644);
    loadOrCreateMemoryKeys(dataDir);
    expect(statSync(memoryKeysFile(dataDir)).mode & 0o777).toBe(0o600);
  });
});

describe("the engine's config file", () => {
  it("holds no credential and names the root user", () => {
    const keys = loadOrCreateMemoryKeys(tempFolder("hobbots-keys-"));
    const config = renderEngineConfig({ model: { provider: "anthropic", name: "claude-haiku-4-5" } });
    expect(config).toContain('root_username = "you"');
    expect(config).toContain('llm_provider = "anthropic"');
    expect(config).toContain('embedding_provider = "none"');
    expect(configHoldsCredential(config, keys)).toBe(false);
    expect(configHoldsCredential(`${config}\nbearer_token = "x"\n`, keys)).toBe(true);
    expect(configHoldsCredential(`${config}\n# ${Redacted.value(keys.proxy)}\n`, keys)).toBe(true);
  });

  it("refuses a setting that is not a plain name", () => {
    expect(() => renderEngineConfig({ model: { provider: 'x"\n[auth]\nbearer_token = "y', name: "m" } })).toThrow();
  });
});

describe("the supervised engine", () => {
  // covers ADR 028
  it("[TC-GEN-178] starts the engine with only its bearers and basics in its environment, and stops it with the hub", async () => {
    const before = { ...process.env };
    process.env.HOBBOTS_TEST_SECRET = "hub-only";
    let pid = 0;
    let dataDir = "";
    try {
      await withEngine({}, (engine, data) =>
        Effect.gen(function* () {
          dataDir = data;
          const health = yield* until(engine, (each) => each.state === "running");
          expect(health).toMatchObject({ state: "running", offReason: null, version: AI_MEMORY_VERSION, restarts: 0 });
          const endpoint = Option.getOrThrow(yield* engine.endpoint);
          expect(endpoint.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

          const [start] = startsOf(data);
          pid = start?.pid ?? 0;
          const keys = loadOrCreateMemoryKeys(data);
          expect(start?.env.AI_MEMORY_AUTH_TOKEN).toBe(Redacted.value(keys.root));
          expect(start?.env.AI_MEMORY_AUTH__ACTOR_PROXY_BEARER_TOKEN).toBe(Redacted.value(keys.proxy));
          expect(start?.env.HOBBOTS_TEST_SECRET).toBeUndefined();
          expect(
            Object.keys(start?.env ?? {})
              // The stand-in is a Node script: the shell and macOS's Node add these to its own environment.
              .filter((key) => !["PWD", "SHLVL", "_", "__CF_USER_TEXT_ENCODING"].includes(key))
              .sort(),
          ).toEqual(["AI_MEMORY_AUTH_TOKEN", "AI_MEMORY_AUTH__ACTOR_PROXY_BEARER_TOKEN", "HOME", "NO_COLOR", "PATH"]);
          expect(start?.args.slice(0, 3)).toEqual(["serve", "--transport", "http"]);
          expect(start?.args).not.toContain("run");

          const config = readFileSync(join(data, "memory", "config.toml"), "utf8");
          expect(configHoldsCredential(config, keys)).toBe(false);
          expect(isAlive(pid)).toBe(true);
        }),
      );
    } finally {
      process.env = before;
    }
    expect(pid).toBeGreaterThan(0);
    expect(isAlive(pid)).toBe(false);
    expect(startsOf(dataDir)).toHaveLength(1);
  });

  // covers ADR 028
  it("[TC-GEN-179] starts a crashed engine again with a growing, capped backoff and reports it", async () => {
    await withEngine({}, (engine, data) =>
      Effect.gen(function* () {
        yield* until(engine, (each) => each.state === "running");
        // Every start from now on crashes at once.
        writeFileSync(join(data, "memory", "crash"), "");
        const [first] = startsOf(data);
        process.kill(first?.pid ?? 0, "SIGKILL");
        const crashing = yield* until(engine, (each) => each.restarts >= 4);
        expect(crashing.state).toBe("restarting");
        expect(crashing.runningSince).toBeNull();
        expect(crashing.lastExit?.code).toBe(3);
        expect(Option.isNone(yield* engine.endpoint)).toBe(true);

        rmSync(join(data, "memory", "crash"));
        const back = yield* until(engine, (each) => each.state === "running");
        expect(back.restarts).toBeGreaterThanOrEqual(4);
        expect(back.lastExit?.code).toBe(3);
      }),
    );
  });

  // covers ADR 028
  it("[TC-GEN-180] starts an engine that stopped answering again", async () => {
    await withEngine({}, (engine, data) =>
      Effect.gen(function* () {
        yield* until(engine, (each) => each.state === "running");
        const [first] = startsOf(data);
        writeFileSync(join(data, "memory", "hang"), "");
        yield* until(engine, (each) => each.restarts >= 1);
        rmSync(join(data, "memory", "hang"));
        yield* until(engine, (each) => each.state === "running");
        expect(isAlive(first?.pid ?? 0)).toBe(false);
        expect(startsOf(data).length).toBeGreaterThanOrEqual(2);
      }),
    );
    // Each missed check waits up to two seconds for an answer.
  }, 20_000);

  // covers ADR 028
  it("[TC-GEN-181] restarts only the engine's process when its settings change", async () => {
    await withEngine({}, (engine, data) =>
      Effect.gen(function* () {
        yield* until(engine, (each) => each.state === "running");
        yield* engine.reconfigure({ model: null });
        yield* Effect.sleep("300 millis");
        expect(startsOf(data)).toHaveLength(1);

        yield* engine.reconfigure({ model: { provider: "anthropic", name: "claude-haiku-4-5" } });
        yield* until(engine, (each) => each.state === "running" && startsOf(data).length === 2);
        const [first, second] = startsOf(data);
        expect(second?.pid).not.toBe(first?.pid);
        expect(isAlive(first?.pid ?? 0)).toBe(false);
        expect(readFileSync(join(data, "memory", "config.toml"), "utf8")).toContain('llm_model = "claude-haiku-4-5"');
        // A restart that was asked for is not a crash.
        expect((yield* engine.health).lastExit).toBeNull();
      }),
    );
  });

  // covers ADR 028
  it("[TC-GEN-182] turns memory off, not the hub, when the binary fails its checksum or is missing", async () => {
    const folder = await standInEngine();
    folders.push(folder);
    writeFileSync(join(folder, ENGINE_CHECKSUM), `${"0".repeat(64)}  ai-memory\n`);
    await withEngine({ folder }, (engine, data) =>
      Effect.gen(function* () {
        expect(yield* engine.health).toMatchObject({ state: "off", offReason: "checksum" });
        expect(Option.isNone(yield* engine.endpoint)).toBe(true);
        yield* Effect.sleep("200 millis");
        expect(startsOf(data)).toHaveLength(0);
      }),
    );
    await withEngine({ folder: tempFolder("hobbots-no-engine-") }, (engine) =>
      Effect.map(engine.health, (health) => expect(health).toMatchObject({ state: "off", offReason: "missing" })),
    );
  });

  // covers ADR 028
  it("[TC-GEN-190] checks the binary again before a restart and turns memory off when it was replaced", async () => {
    const folder = await standInEngine();
    folders.push(folder);
    await withEngine({ folder }, (engine, data) =>
      Effect.gen(function* () {
        yield* until(engine, (each) => each.state === "running");
        const [first] = startsOf(data);
        // The binary changes under a running hub, then the engine exits.
        writeFileSync(join(folder, ENGINE_BINARY), "#!/bin/sh\necho replaced\n");
        process.kill(first?.pid ?? 0, "SIGKILL");
        const off = yield* until(engine, (each) => each.state === "off");
        expect(off.offReason).toBe("checksum");
        expect(Option.isNone(yield* engine.endpoint)).toBe(true);
        yield* Effect.sleep("300 millis");
        // The replaced binary was never started.
        expect(startsOf(data)).toHaveLength(1);
      }),
    );
  });

  // covers ADR 028, STD-EFFECT-002
  it("[TC-GEN-191] tries a start that could not launch again with the backoff, and recovers", async () => {
    await withEngine({}, (engine, data) =>
      Effect.gen(function* () {
        yield* until(engine, (each) => each.state === "running");
        const [first] = startsOf(data);
        // The config file cannot be written, so the next starts fail before the process launches.
        const config = join(data, "memory", "config.toml");
        rmSync(config);
        mkdirSync(config);
        process.kill(first?.pid ?? 0, "SIGKILL");
        const failing = yield* until(engine, (each) => each.restarts >= 3);
        expect(failing.state).toBe("restarting");
        expect(failing.lastExit?.code).toBeNull();
        expect(startsOf(data)).toHaveLength(1);

        rmSync(config, { recursive: true });
        const back = yield* until(engine, (each) => each.state === "running");
        expect(back.restarts).toBeGreaterThanOrEqual(3);
        expect(startsOf(data)).toHaveLength(2);
      }),
    );
  });

  // covers ADR 028 (Backups), OP-003
  it("[TC-OP-097] backs up through the engine with the root bearer, refuses an archive holding a bearer, and packs memory while off", async () => {
    /** A memory archive whose config is `config`, served by the stand-in as its backup. */
    const serve = async (data: string, config: string) => {
      const source = tempFolder("hobbots-source-");
      mkdirSync(join(source, "wiki"), { recursive: true });
      writeFileSync(join(source, "wiki", "page.md"), "# Page");
      writeFileSync(join(source, "config.toml"), config);
      await create({ file: join(data, "memory", "stand-in-backup.tar.gz"), cwd: source, gzip: true }, [
        "wiki",
        "config.toml",
      ]);
    };
    await withEngine({}, (engine, data) =>
      Effect.gen(function* () {
        yield* until(engine, (each) => each.state === "running");
        const out = tempFolder("hobbots-backup-");
        const failed = yield* Effect.flip(engine.backup(join(out, "none.tar.gz")));
        expect(failed.reason).toMatch(/memory's backup failed/);
        expect(existsSync(join(out, "none.tar.gz"))).toBe(false);

        yield* Effect.promise(() => serve(data, renderEngineConfig({ model: null })));
        expect(yield* engine.backup(join(out, "good.tar.gz"))).toBe(true);
        expect(statSync(join(out, "good.tar.gz")).mode & 0o777).toBe(0o600);

        const keys = loadOrCreateMemoryKeys(data);
        rmSync(join(data, "memory", "stand-in-backup.tar.gz"));
        yield* Effect.promise(() => serve(data, `token = "${Redacted.value(keys.proxy)}"\n`));
        const refused = yield* Effect.flip(engine.backup(join(out, "bad.tar.gz")));
        expect(refused.reason).toMatch(/config\.toml holds a memory bearer/);
        expect(existsSync(join(out, "bad.tar.gz"))).toBe(false);
      }),
    );

    // With the engine off, its folder is packed as it is.
    const folder = await standInEngine();
    folders.push(folder);
    writeFileSync(join(folder, ENGINE_CHECKSUM), `${"0".repeat(64)}  ai-memory\n`);
    const dataDir = tempFolder("hobbots-data-");
    const out = tempFolder("hobbots-backup-");
    await withEngine({ folder, dataDir }, (engine) => engine.backup(join(out, "empty.tar.gz")));
    expect(existsSync(join(out, "empty.tar.gz"))).toBe(false);
    mkdirSync(join(dataDir, "memory", "wiki"), { recursive: true });
    writeFileSync(join(dataDir, "memory", "wiki", "page.md"), "# Page");
    expect(await withEngine({ folder, dataDir }, (engine) => engine.backup(join(out, "off.tar.gz")))).toBe(true);
    expect(existsSync(join(out, "off.tar.gz"))).toBe(true);
  });
});
