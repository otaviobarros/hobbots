import type { MemoryStoreShape } from "@hobbots/agents";
import { AgentId, MemoryPath, type MemoryScope, MemoryUnavailable, memoryProjectIdentity } from "@hobbots/domain";
import { Effect, Exit, Redacted, Scope } from "effect";
import { describe, expect, it, vi } from "vitest";
import { engineProjectOf, INDEX_PROJECT, scopeOfEngineProject } from "../src/store/scopes.ts";
import { engineDataDir, engineEnabled, startEngineStore } from "./engine-store.ts";
import { memoryStoreContract } from "./store-contract.ts";

// The shared MemoryStore tests on the bundled ai-memory (ADR 028), run as the engine's contract tests
// are: skipped without the engine, and failed for its absence in CI (HOBBOTS_MEMORY_CONTRACT=1).

vi.setConfig({ testTimeout: 60_000 });

const open = () =>
  Effect.gen(function* () {
    const { dataDir, keys } = engineDataDir();
    const first = yield* startEngineStore(dataDir, keys);
    // A second run: the engine stops with the hub and starts again on the same data.
    const reopen: Effect.Effect<MemoryStoreShape> = Effect.gen(function* () {
      yield* Scope.close(first.scope, Exit.void);
      return (yield* startEngineStore(dataDir, keys)).store;
    });
    return { store: first.store, reopen, endpoint: first.endpoint, keys };
  });

describe.runIf(engineEnabled)("the ai-memory MemoryStore", () => {
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

describe.runIf(engineEnabled)("ai-memory projects Hobbots did not make", () => {
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
