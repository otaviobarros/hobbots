import { CharmCalls, HobbotsRepository, TaskToolCalls } from "@hobbots/agents";
import { Agent, AgentId, CharmCall, MessageId, TaskToolRefused, ThreadId } from "@hobbots/domain";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/sql";
import { describe, expect, it } from "vitest";
import { CharmCallsLive, EventJournal, HobbotsRepositoryLive, migrations, TaskToolCallsLive } from "../src/index.ts";
import callKeyScopes from "../src/migrations/0045_call_key_scopes.ts";
import { TestDatabase, TestDatabaseAt } from "../src/testing.ts";

// A tool call's key is unique within the work it belongs to, not among all of its hob's calls
// (#660), on SQLite and PostgreSQL (STD-TEST-006).

const TestLayer = Layer.mergeAll(HobbotsRepositoryLive, TaskToolCallsLive, CharmCallsLive, EventJournal.layer).pipe(
  Layer.provideMerge(TestDatabase),
);
const run = <A, E>(
  effect: Effect.Effect<A, E, HobbotsRepository | TaskToolCalls | CharmCalls | EventJournal | SqlClient.SqlClient>,
) => effect.pipe(Effect.provide(TestLayer), Effect.runPromise);

const now = "2026-11-03T00:00:00.000Z";
const FRODO = AgentId.make("frodo");

const agent = new Agent({
  id: FRODO,
  name: "Frodo",
  roleTitle: "Lead",
  runtime: "claude-code",
  model: null,
  effort: null,
  instructions: "",
  lookSeed: 1,
  lookColor: "moss",
  configVersion: 1,
  createdAt: now,
});

const seed = Effect.flatMap(HobbotsRepository, (repo) => repo.insertAgent(agent));

const checkpoint = (scope: string, summary: string) => ({
  agentId: FRODO,
  scope,
  key: "cp-tests-passing",
  tool: "report_checkpoint" as const,
  input: JSON.stringify({ kind: "progress", summary }),
  at: now,
});

describe("tool call keys per Task", () => {
  // covers OR-001, EX-001
  it("[TC-OR-420] the same key is a new call on another Task, a retry on the same one, and refused for another call there", async () => {
    await run(
      Effect.gen(function* () {
        yield* seed;
        const ledger = yield* TaskToolCalls;
        let runs = 0;
        const report = (message: string) =>
          Effect.sync(() => {
            runs++;
            return { done: { message, details: {} }, entries: [] };
          });

        // A key Frodo chose for one Task is free again for the next.
        const first = yield* ledger.once(checkpoint("task:quest-a", "Green"), report("First"));
        const second = yield* ledger.once(checkpoint("task:quest-b", "Green"), report("Second"));
        expect([first.done.message, second.done.message, runs]).toEqual(["First", "Second", 2]);

        // The same call again on the same Task is a retry: its first result, run once.
        const retried = yield* ledger.once(checkpoint("task:quest-b", "Green"), report("Third"));
        expect(retried).toEqual({ done: second.done, entries: [] });
        expect(runs).toBe(2);

        // Another call with the same key on the same Task is still refused.
        const reused = yield* Effect.flip(ledger.once(checkpoint("task:quest-b", "Red"), report("Fourth")));
        expect(reused).toMatchObject({ _tag: "TaskToolRefused", reason: "key-reused" });
        expect(runs).toBe(2);

        // A reply's first run starts its Task; on Continue the turn is on that Task, and still finds the call.
        const started = yield* ledger.once(checkpoint("reply:m1", "Started"), report("Fifth"));
        const continued = yield* ledger.once(
          { ...checkpoint("task:quest-c", "Started"), also: "reply:m1" },
          report("Sixth"),
        );
        expect(continued).toEqual({ done: started.done, entries: [] });
        expect(runs).toBe(3);
      }),
    );
  });

  // covers OR-007
  it("[TC-OR-421] a refusal is recorded per Task and key, so a refused key on one Task never merges with another's", async () => {
    await run(
      Effect.gen(function* () {
        yield* seed;
        const ledger = yield* TaskToolCalls;
        const refused = new TaskToolRefused({ reason: "not-owner", message: "Not yours." });
        const call = (scope: string) => ({
          agentId: FRODO,
          scope,
          key: "wait-pip-1",
          tool: "wait_for",
          input: "{}",
          taskId: null,
          refused,
          at: now,
        });
        const one = yield* ledger.refused(call("task:quest-a"));
        const again = yield* ledger.refused(call("task:quest-a"));
        const other = yield* ledger.refused(call("task:quest-b"));
        expect(again.value).toMatchObject({ id: one.value.id, tries: 2 });
        expect(other.value).toMatchObject({ tries: 1 });
        expect(other.value.id).not.toBe(one.value.id);
      }),
    );
  });

  // covers OR-007, EX-003
  it("[TC-OR-424] a refused Charm call is stored with its code, and a retry with its key is the same record", async () => {
    await run(
      Effect.gen(function* () {
        yield* seed;
        const ledger = yield* TaskToolCalls;
        const call = {
          agentId: FRODO,
          scope: "task:quest-a",
          key: "push-1",
          tool: "github_push",
          input: '{"branch":"feat/x"}',
          taskId: null,
          refused: new TaskToolRefused({ reason: "charm-refused", message: "GitHub refused the push." }),
          at: now,
        };
        const first = yield* ledger.refused(call);
        const again = yield* ledger.refused(call);
        expect(first.value).toMatchObject({ tool: "github_push", reason: "charm-refused", tries: 1 });
        expect(again.value).toMatchObject({ id: first.value.id, tries: 2 });
        const sql = yield* SqlClient.SqlClient;
        expect(yield* sql`SELECT id FROM task_tool_refusals`).toHaveLength(1);
      }),
    );
  });

  // covers IN-003, EX-003
  it("[TC-OR-422] a Charm call's key is a new call in other work, and returns the first call in its own", async () => {
    const write = (messageId: string, attempt: string) =>
      new CharmCall({
        agentId: FRODO,
        scope: `reply:${messageId}`,
        key: "push-1",
        attempt,
        charm: "GitHub",
        tool: "github_push",
        input: `{"branch":"feat/x"}`,
        site: "github.com/octo/app refs/heads/feat/x",
        plan: "{}",
        appliedText: "Pushed.",
        state: "sending",
        result: null,
        threadId: ThreadId.make("t1"),
        messageId: MessageId.make(messageId),
        stepId: null,
        createdAt: now,
        updatedAt: now,
      });
    await run(
      Effect.gen(function* () {
        yield* seed;
        const calls = yield* CharmCalls;
        expect((yield* calls.begin(write("m1", "a1")))._tag).toBe("Started");
        yield* calls.settle(write("m1", "a1"), "applied", "Pushed.", now);
        expect(yield* calls.begin(write("m1", "a2"))).toMatchObject({ _tag: "Existing", call: { attempt: "a1" } });
        expect((yield* calls.begin(write("m2", "a3")))._tag).toBe("Started");
        // On Continue, a turn now on a Task still finds what its reply sent.
        const onTask = new CharmCall({ ...write("m1", "a4"), scope: "task:quest-a" });
        expect(yield* calls.begin(onTask, "reply:m1")).toMatchObject({ _tag: "Existing", call: { attempt: "a1" } });
        const later = Option.getOrThrow(yield* calls.find(FRODO, ["reply:m2"], "push-1"));
        expect(later.attempt).toBe("a3");
      }),
    );
  });

  // covers EX-004, OR-001
  it("[TC-OR-427] an uncertain Charm call moved to the Task its reply started is still found and settled by its sending", async () => {
    await run(
      Effect.gen(function* () {
        yield* seed;
        const calls = yield* CharmCalls;
        const ledger = yield* TaskToolCalls;
        const sent = new CharmCall({
          agentId: FRODO,
          scope: "reply:m1",
          key: "push-1",
          attempt: "a1",
          charm: "GitHub",
          tool: "github_push",
          input: `{"branch":"feat/x"}`,
          site: "github.com/octo/app refs/heads/feat/x",
          plan: "{}",
          appliedText: "Pushed.",
          state: "sending",
          result: null,
          threadId: ThreadId.make("t1"),
          messageId: MessageId.make("m1"),
          stepId: null,
          createdAt: now,
          updatedAt: now,
        });
        yield* calls.begin(sent);
        yield* calls.settle(sent, "uncertain", "No answer.", now);
        // The reply starts its Task: its calls move to the Task's work.
        yield* ledger.once(
          checkpoint("reply:m1", "Started"),
          Effect.succeed({ done: { message: "Started", details: {} }, entries: [], scope: "task:quest-a" }),
        );
        // The watcher holds the sending as it was recorded, and still finds and settles it.
        expect(yield* calls.current(sent)).toMatchObject(Option.some({ scope: "task:quest-a", state: "uncertain" }));
        const settled = yield* calls.settle(sent, "applied", "Pushed.", now);
        expect(settled).toMatchObject(Option.some({ scope: "task:quest-a", state: "applied" }));
      }),
    );
  });

  // covers DP-003
  it("[TC-OR-423] 0045 keeps every stored call and refusal readable, each in the work its input names, compared without its turn", async () => {
    // Keeps 0047, 0076, 0079, 0080 and 0082 too: the repository that seeds the hob writes its name with
    // each version, its Charms, whether other hobs see it, its good at and who made and summoned it.
    const earlier = Object.fromEntries(
      Object.entries(migrations).filter(
        ([id]) =>
          id < "0045" ||
          [
            "0047_versioned_name",
            "0076_charm_grants",
            "0079_hob_visibility",
            "0080_hob_good_at",
            "0082_hob_actors",
          ].includes(id),
      ),
    ) as typeof migrations;
    const rows = await Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seed;
      yield* sql`INSERT INTO task_tool_calls ${sql.insert({
        agentId: FRODO,
        callKey: "chat",
        tool: "report_checkpoint",
        input: '{"turn_reply":"m1"}',
        result: "{}",
        createdAt: now,
      })}`;
      yield* sql`INSERT INTO task_tool_calls ${sql.insert({
        agentId: FRODO,
        callKey: "step",
        tool: "report_checkpoint",
        input: '{"turn_task":"t1"}',
        result: "{}",
        createdAt: now,
      })}`;
      yield* sql`INSERT INTO task_tool_refusals ${sql.insert({
        id: "r1",
        agentId: FRODO,
        callKey: "cut",
        taskId: null,
        tool: "plan_steps",
        input: '{"steps":[{"brief":"x…',
        reason: "invalid-input",
        message: "Cut.",
        tries: 1,
        createdAt: now,
        refusedAt: now,
      })}`;
      yield* sql`INSERT INTO charm_calls ${sql.insert({
        agentId: FRODO,
        callKey: "push",
        attempt: "a1",
        tool: "github_push",
        input: "{}",
        site: "s",
        plan: "{}",
        state: "applied",
        result: null,
        threadId: null,
        messageId: "m2",
        stepId: null,
        createdAt: now,
        updatedAt: now,
      })}`;
      yield* callKeyScopes;
      return {
        calls: yield* sql`SELECT call_key, scope, input FROM task_tool_calls ORDER BY call_key`,
        refusals: yield* sql`SELECT call_key, scope FROM task_tool_refusals`,
        charms: yield* sql`SELECT call_key, scope FROM charm_calls`,
      };
    }).pipe(
      Effect.provide(Layer.mergeAll(HobbotsRepositoryLive).pipe(Layer.provideMerge(TestDatabaseAt(earlier)))),
      Effect.runPromise,
    );

    expect(rows).toEqual({
      calls: [
        { callKey: "chat", scope: "reply:m1", input: "{}" },
        { callKey: "step", scope: "task:t1", input: "{}" },
      ],
      refusals: [{ callKey: "cut", scope: "" }],
      charms: [{ callKey: "push", scope: "reply:m2" }],
    });
  });
});
