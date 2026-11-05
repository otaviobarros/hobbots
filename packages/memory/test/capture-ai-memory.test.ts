import type { MemoryStoreShape } from "@hobbots/agents";
import { Effect, Redacted } from "effect";
import { describe, vi } from "vitest";
import { MEMORY_WORKSPACE } from "../src/engine/engine.ts";
import { engineActorOf } from "../src/store/scopes.ts";
import { engineEnabled, freshDataDir, type RunningEngine, startEngine } from "./ai-memory-engine.ts";
import { captureContract } from "./capture-contract.ts";

// The capture worker's tests on the bundled ai-memory (ADR 028): an outage stops the real engine and
// starts it again on its data, and replays are skipped by ai-memory's own ingest keys.
vi.setConfig({ testTimeout: 90_000 });

/**
 * How many observations ai-memory keeps of a thread's session, its ends left out, read as the hob:
 * ai-memory shows a session only to the actor that owns it.
 */
const observationsOf = (engine: RunningEngine, hob: string, threadId: string) =>
  Effect.promise(async () => {
    const response = await fetch(`${engine.endpoint.url}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${Redacted.value(engine.endpoint.proxy)}`,
        "x-memory-actor-user": hob,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "memory_read_session_observations",
          arguments: { workspace: MEMORY_WORKSPACE, project: hob, session_id: threadId, limit: 100 },
        },
      }),
    });
    const rpc = (await response.json()) as {
      result?: { content: Array<{ text: string }>; isError?: boolean };
      error?: { message: string };
    };
    // A session memory never saw holds nothing.
    if (rpc.error?.message.includes("not found") === true) return 0;
    if (rpc.error !== undefined || rpc.result?.isError === true) throw new Error(JSON.stringify(rpc));
    const json = JSON.parse(rpc.result?.content[0]?.text ?? "{}") as { observations?: Array<{ kind: string }> };
    return (json.observations ?? []).filter((observation) => observation.kind !== "session-end").length;
  });

describe.runIf(engineEnabled)("memory capture on ai-memory", () => {
  captureContract("ai-memory", () =>
    Effect.gen(function* () {
      const { dataDir, keys } = freshDataDir();
      let engine = yield* startEngine(dataDir, keys);
      // The worker keeps the store it was given, as the hub's does across an engine restart.
      const store = new Proxy({} as MemoryStoreShape, {
        get: (_target, key) => Reflect.get(engine.store, key),
      });
      return {
        store,
        observations: (agentId, threadId) => observationsOf(engine, engineActorOf(agentId), threadId),
        down: Effect.promise(() => Effect.runPromise(engine.stop)),
        up: Effect.promise(async () => {
          engine = await Effect.runPromise(startEngine(dataDir, keys));
        }),
      };
    }),
  );
});
