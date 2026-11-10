import { NodeServices } from "@effect/platform-node";
import { MemoryStore, MemoryVersionAuthors } from "@hobbots/agents";
import { AgentId, DEFAULT_MEMORY_SETTINGS, type MemoryActor, type MemoryScope, ThreadId } from "@hobbots/domain";
import { Context, Effect, Exit, Layer, Redacted, Schedule, Scope } from "effect";
import { FetchHttpClient } from "effect/http";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { defaultEngineFolder } from "../src/engine/binary.ts";
import { MemoryEngine } from "../src/engine/engine.ts";
import { engineSettingsFor } from "../src/engine/model.ts";
import { MemoryModelEndpoint } from "../src/engine/model-endpoint.ts";
import { MemoryStoreAiMemory } from "../src/store/ai-memory.ts";
import { engineDataDir, engineEnabled } from "./engine-store.ts";
import { claude, codex, resetStandIns, standInRuntimes } from "./runtime-stand-ins.ts";

// A finished chat's summary on the bundled ai-memory (ADR 028, issue #980): the engine sums it up
// with the memory model, which runs as a turn on the chosen runtime's adapter, on its sign-in, with
// no API key anywhere. The runtimes are stand-ins that record each turn.

const pip = AgentId.make("0d6e2f0a-0000-4000-8000-000000000001");
const asPip: MemoryActor = { _tag: "Hob", agentId: pip, projects: [] };
const pipsOwn: MemoryScope = { _tag: "Hob", agentId: pip };

const scopes: Array<Scope.Closeable> = [];
afterAll(async () => {
  for (const scope of scopes) await Effect.runPromise(Scope.close(scope, Exit.void));
}, 60_000);

beforeEach(resetStandIns);

describe.runIf(engineEnabled)("a finished chat's summary", () => {
  // covers ADR 028
  it("[TC-GEN-319] is written by the chosen Claude model through its adapter, as a turn of no hob's", async () => {
    const { dataDir, keys } = engineDataDir();
    const scope = await Effect.runPromise(Scope.make());
    scopes.push(scope);
    const engine = MemoryEngine.layer({
      folder: process.env.HOBBOTS_MEMORY_ENGINE_DIR ?? defaultEngineFolder() ?? "",
      dataDir,
      keys,
      settings: engineSettingsFor({ ...DEFAULT_MEMORY_SETTINGS, effort: "medium" }),
    });
    const layer = MemoryStoreAiMemory.pipe(
      Layer.provideMerge(engine),
      Layer.provideMerge(MemoryModelEndpoint.layer(keys.model).pipe(Layer.provide(standInRuntimes))),
      Layer.provide(
        Layer.mergeAll(
          NodeServices.layer,
          FetchHttpClient.layer,
          Layer.succeed(MemoryVersionAuthors, MemoryVersionAuthors.make()),
        ),
      ),
    );
    const context = await Effect.runPromise(Layer.buildWithScope(layer, scope));
    await Effect.runPromise(
      Context.get(context, MemoryEngine).health.pipe(
        Effect.repeat({ schedule: Schedule.spaced("100 millis"), until: (health) => health.state === "running" }),
        Effect.timeout("60 seconds"),
      ),
    );
    // The engine holds the model bearer only in its environment, never a provider key.
    expect(Redacted.value(keys.model)).toMatch(/^[0-9a-f]{64}$/);

    const store = Context.get(context, MemoryStore);
    const thread = ThreadId.make("0d6e2f0a-0000-4000-8000-0000000000a1");
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* store.capture(asPip, pipsOwn, thread, [
          { key: "message:m1", kind: "message", text: "Release notes go in CHANGELOG.md, newest first." },
        ]);
        yield* store.endSession(asPip, pipsOwn, thread, "end:m1");
      }),
    );
    // The engine queues the summary when the session ends, then asks its model.
    await Effect.runPromise(
      Effect.sync(() => claude.turns.length).pipe(
        Effect.repeat({ schedule: Schedule.spaced("200 millis"), until: (turns) => turns > 0 }),
        Effect.timeout("60 seconds"),
      ),
    );
    const [turn] = claude.turns;
    expect(turn).toMatchObject({
      sessionId: null,
      model: "quick",
      effort: null,
      tools: null,
      hubTools: null,
      approvals: null,
      ephemeral: true,
    });
    expect(`${turn?.instructions}\n${turn?.prompt}`).toContain("CHANGELOG.md");
    expect(codex.turns).toHaveLength(0);
  }, 120_000);
});
