import { HobbotsRepository, HobChanges } from "@hobbots/agents";
import { Agent, AgentId, type ChangeActor, roleFields, YOU } from "@hobbots/domain";
import { HobbotsRepositoryLive, HobChangesLive } from "@hobbots/persistence";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/sql";
import { describe, expect, it } from "vitest";
import { TestDatabase } from "../src/testing.ts";

const TestLayer = Layer.mergeAll(HobbotsRepositoryLive, HobChangesLive).pipe(Layer.provideMerge(TestDatabase));
const wren = AgentId.make("wren");
const chief = AgentId.make("chief");
const now = "2026-11-08T00:00:00.000Z";

const hob = (id: AgentId, name: string) =>
  new Agent({
    id,
    name,
    ...roleFields("writer"),
    runtime: "claude-code",
    model: null,
    effort: null,
    instructions: "",
    lookSeed: 1,
    lookColor: "moss",
    configVersion: 1,
    createdAt: now,
  });

describe("HobChanges", () => {
  // covers AG-002, AG-006, DP-003
  it("[TC-AG-411-03] keeps every version and status change with its actor past the journal, and finds the call behind a hob's change", async () => {
    const reply: ChangeActor = { _tag: "Hob", hobId: chief, call: { scope: "reply:m1", key: "k1" } };
    const result = await Effect.gen(function* () {
      const repo = yield* HobbotsRepository;
      const sql = yield* SqlClient.SqlClient;
      yield* repo.insertAgent(hob(chief, "Chief"));
      const created = Option.getOrThrow(yield* repo.insertAgent(hob(wren, "Wren"))).value;
      yield* sql`INSERT INTO threads ${sql.insert({
        id: "t1",
        agent_id: chief,
        title: "Hiring",
        created_at: now,
        updated_at: now,
      })}`;
      yield* sql`INSERT INTO messages ${sql.insert({
        id: "m1",
        thread_id: "t1",
        seq: 1,
        role: "assistant",
        content: "",
        status: "complete",
        created_at: now,
      })}`;
      const renamed = Option.getOrThrow(
        yield* repo.updateAgentConfig(new Agent({ ...created, name: "Ash", configVersion: 2 }), reply),
      ).value;
      yield* repo.setAgentStatus(new Agent({ ...renamed, status: "paused" }), "active", reply);
      // The journal is compacted after seven days; the changes are not read from it.
      yield* sql`DELETE FROM event_journal`;
      const changes = yield* HobChanges;
      return { forHob: yield* changes.forHob(wren), latest: yield* changes.latest(2) };
    }).pipe(Effect.provide(TestLayer), Effect.scoped, Effect.runPromise);

    expect(result.forHob.map((change) => [change._tag, change.actor._tag])).toEqual([
      ["Status", "Hob"],
      ["Version", "Hob"],
      ["Version", "You"],
    ]);
    expect(result.forHob[0]).toMatchObject({
      from: "active",
      status: "paused",
      origin: { charm: null, taskId: null, threadId: "t1", messageId: "m1" },
    });
    expect(result.forHob[1]).toMatchObject({
      config: { version: 2, name: "Ash" },
      previous: { version: 1, name: "Wren" },
    });
    expect(result.forHob[2]).toMatchObject({ actor: YOU, origin: null, previous: null });
    // The newest across every hob, each version still with the one before it.
    expect(result.latest).toHaveLength(2);
    expect(result.latest[1]).toMatchObject({ _tag: "Version", previous: { version: 1 } });
  });
});
