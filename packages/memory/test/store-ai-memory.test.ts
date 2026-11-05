import type { MemoryStoreShape } from "@hobbots/agents";
import { memoryProjectIdentity } from "@hobbots/domain";
import { Effect, Exit, Scope } from "effect";
import { describe, expect, it, vi } from "vitest";
import { engineProjectOf } from "../src/store/scopes.ts";
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
    return { store: first.store, reopen };
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
});
