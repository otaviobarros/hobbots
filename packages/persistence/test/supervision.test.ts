import { SupervisionRecords } from "@hobbots/agents";
import { AttemptId, Supervision, SupervisionMachine, TaskId, watching } from "@hobbots/domain";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { describe, expect, it } from "vitest";
import { SupervisionRecordsLive } from "../src/index.ts";
import { TestDatabase } from "../src/testing.ts";

// Issue #1447: the supervisor's record of each Task it acted on holds across restarts, on SQLite and
// PostgreSQL alike (STD-TEST-006), so a retry budget is never spent twice.

const run = <A, E>(effect: Effect.Effect<A, E, SupervisionRecords | SqlClient.SqlClient>) =>
  effect.pipe(Effect.provide(SupervisionRecordsLive.pipe(Layer.provideMerge(TestDatabase))), Effect.runPromise);

const at = "2026-11-14T10:00:00.000Z";
const later = "2026-11-14T10:05:00.000Z";
const root = TaskId.make("top");
const page = { id: TaskId.make("page"), rootId: root };
const tests = { id: TaskId.make("tests"), rootId: root };

describe("supervision records", () => {
  it("keeps each Task's record by its tree, the latest change replacing the one before", async () => {
    const failed = SupervisionMachine.transition(watching(page, at), {
      _tag: "Failed",
      at: later,
      attemptId: AttemptId.make("a1"),
      retryable: true,
      reason: "The runtime ended without a result.",
    });
    if (!(failed instanceof Supervision)) throw failed;
    const result = await run(
      Effect.gen(function* () {
        const records = yield* SupervisionRecords;
        yield* records.save(watching(page, at));
        yield* records.save(watching(tests, at));
        yield* records.save(watching({ id: TaskId.make("other"), rootId: TaskId.make("elsewhere") }, at));
        yield* records.save(failed);
        return yield* records.listIn(root);
      }),
    );
    expect(result).toEqual([failed, watching(tests, at)]);
    expect(result[0]).toMatchObject({ state: "retrying", retries: 1, rule: "retry", attemptId: "a1" });
  });

  it("skips a row this Hobbots cannot read, so the supervisor looks at that Task afresh", async () => {
    const result = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const records = yield* SupervisionRecords;
        yield* records.save(watching(page, at));
        yield* sql`INSERT INTO task_supervision ${sql.insert({
          task_id: "tests",
          root_id: "top",
          state: "dreaming",
          retries: 0,
          refusals_seen: 0,
          attempt_id: null,
          rule: null,
          reason: null,
          updated_at: at,
        })}`;
        return yield* records.listIn(root);
      }),
    );
    expect(result).toEqual([watching(page, at)]);
  });
});
