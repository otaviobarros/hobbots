import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeServices } from "@effect/platform-node";
import { MemoryStore, type MemoryStoreShape } from "@hobbots/agents";
import { AgentId, MemoryPath, type MemoryScope, MemoryUnavailable, memoryProjectIdentity } from "@hobbots/domain";
import { Context, Effect, Exit, Layer, Option, Redacted, Schedule, Scope } from "effect";
import { FetchHttpClient } from "effect/http";
import { afterAll, describe, expect, it, vi } from "vitest";
import { defaultEngineFolder, ENGINE_BINARY } from "../src/engine/binary.ts";
import { MemoryEngine } from "../src/engine/engine.ts";
import { loadOrCreateMemoryKeys, type MemoryKeys } from "../src/engine/keys.ts";
import { MemoryStoreAiMemory } from "../src/store/ai-memory.ts";
import { engineProjectOf, INDEX_PROJECT, scopeOfEngineProject } from "../src/store/scopes.ts";
import { memoryStoreContract } from "./store-contract.ts";

// The shared MemoryStore tests on the bundled ai-memory (ADR 028), run as the engine's contract tests
// are: skipped without the engine, and failed for its absence in CI (HOBBOTS_MEMORY_CONTRACT=1).
const folder = process.env.HOBBOTS_MEMORY_ENGINE_DIR ?? defaultEngineFolder();
const fetched = folder !== undefined && existsSync(join(folder, ENGINE_BINARY));
const enabled = fetched || process.env.HOBBOTS_MEMORY_CONTRACT === "1";

vi.setConfig({ testTimeout: 60_000 });

const scopes: Array<Scope.Closeable> = [];
const dataDirs: Array<string> = [];

afterAll(async () => {
  for (const scope of scopes) await Effect.runPromise(Scope.close(scope, Exit.void));
  for (const dir of dataDirs) rmSync(dir, { recursive: true, force: true });
}, 60_000);

/** Starts the engine on `dataDir`, as the hub does, and answers its MemoryStore and the scope it runs in. */
const start = (dataDir: string, keys: MemoryKeys) =>
  Effect.gen(function* () {
    if (!fetched) return yield* Effect.die(new Error(`No ai-memory engine in ${folder}; run fetch-engine`));
    const scope = yield* Scope.make();
    scopes.push(scope);
    const engine = MemoryEngine.layer({ folder: folder ?? "", dataDir, keys });
    const layer = MemoryStoreAiMemory.pipe(
      Layer.provideMerge(engine),
      Layer.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
    );
    const context = yield* Layer.buildWithScope(layer, scope);
    yield* Context.get(context, MemoryEngine).health.pipe(
      Effect.repeat({ schedule: Schedule.spaced("100 millis"), until: (health) => health.state !== "starting" }),
      Effect.timeout("60 seconds"),
    );
    if (Option.isNone(yield* Context.get(context, MemoryEngine).endpoint)) {
      return yield* Effect.die(new Error("The memory engine did not start"));
    }
    const endpoint = Option.getOrThrow(yield* Context.get(context, MemoryEngine).endpoint);
    return { store: Context.get(context, MemoryStore), scope, endpoint };
  }).pipe(Effect.orDie);

const open = () =>
  Effect.gen(function* () {
    const dataDir = mkdtempSync(join(tmpdir(), "hobbots-memory-store-"));
    dataDirs.push(dataDir);
    const keys = loadOrCreateMemoryKeys(dataDir);
    const first = yield* start(dataDir, keys);
    // A second run: the engine stops with the hub and starts again on the same data.
    const reopen: Effect.Effect<MemoryStoreShape> = Effect.gen(function* () {
      yield* Scope.close(first.scope, Exit.void);
      return (yield* start(dataDir, keys)).store;
    });
    return { store: first.store, reopen, endpoint: first.endpoint, keys };
  });

describe.runIf(enabled)("the ai-memory MemoryStore", () => {
  memoryStoreContract("ai-memory", open);
});

describe("ai-memory scopes", () => {
  it("keeps each scope in its own ai-memory project", () => {
    const app = memoryProjectIdentity("git@github.com:me/app.git", "app");
    const lookalike = memoryProjectIdentity("git@github.com:me-app/x.git", "x");
    expect(engineProjectOf({ _tag: "Everyone" })).toEqual({ workspace: "default", project: "_global" });
    expect(engineProjectOf({ _tag: "Project", identity: app }).project).toMatch(
      /^repo-github\.com-me-app-[0-9a-f]{10}$/,
    );
    // Identities that read alike as a project name still get projects of their own.
    expect(engineProjectOf({ _tag: "Project", identity: lookalike }).project).not.toBe(
      engineProjectOf({ _tag: "Project", identity: memoryProjectIdentity("git@github.com:me/app-x.git", "x") }).project,
    );
  });

  // covers ADR 028 (Backups), OP-002
  it("[TC-OP-101] reads each engine project back as the scope it holds", () => {
    const app = memoryProjectIdentity("git@github.com:me/app.git", "app");
    const pip = AgentId.make("h-pip");
    for (const scope of [{ _tag: "Everyone" }, { _tag: "Hob", agentId: pip }] as const) {
      expect(scopeOfEngineProject(engineProjectOf(scope))).toEqual(scope);
    }
    // A project's engine name is hashed, so only the index names its identity.
    expect(scopeOfEngineProject(engineProjectOf({ _tag: "Project", identity: app }))).toBe("Project");
    expect(scopeOfEngineProject(INDEX_PROJECT)).toBe(null);
    expect(scopeOfEngineProject({ workspace: "hobbots", project: "scratch" })).toBe(null);
    expect(scopeOfEngineProject({ workspace: "other", project: "hob-h-pip" })).toBe(null);
  });
});

describe.runIf(enabled)("ai-memory projects Hobbots did not make", () => {
  // covers ADR 028 (Backups), OP-002
  it("[TC-OP-102] says memory did not answer in full rather than leave a project it cannot name out", async () => {
    const { store, endpoint, keys } = await Effect.runPromise(open());
    const app: MemoryScope = { _tag: "Project", identity: memoryProjectIdentity("git@github.com:me/app.git", "app") };
    const you = { _tag: "You" } as const;
    const draft = (path: string) => ({ path: MemoryPath.make(path), markdown: "# Page", tags: [], pinned: false });
    await Effect.runPromise(store.write(you, app, draft("a.md"), { _tag: "New" }));
    expect(await Effect.runPromise(store.scopes(you))).toEqual([app]);
    // Pages ai-memory took in some other way, in a project no index page names.
    const response = await fetch(`${endpoint.url}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${Redacted.value(keys.root)}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "memory_write_page",
          arguments: { workspace: "hobbots", project: "repo-foreign-0123456789", path: "c.md", body: "# Page" },
        },
      }),
    });
    expect(response.status).toBe(200);
    const refused = await Effect.runPromise(Effect.flip(store.scopes(you)));
    expect(refused).toBeInstanceOf(MemoryUnavailable);
    expect(refused.message).toMatch(/repo-foreign-0123456789/);
  });
});
