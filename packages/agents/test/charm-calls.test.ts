import { AgentId, CharmCall, MessageId } from "@hobbots/domain";
import { Deferred, Effect, Fiber, Option } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import { type CharmWrite, makeCharmCallRunner, type WriteOutcome } from "../src/index.ts";
import { memoryCharmCalls } from "../src/testing.ts";

const write = (key: string): CharmWrite => ({
  agentId: AgentId.make("hob"),
  scope: "reply:m1",
  tool: "github_push",
  key,
  input: { branch: "feat/x" },
  site: "github.com/octo/app refs/heads/feat/x",
  plan: { commit: "abc" },
  appliedText: "Pushed.",
  step: undefined,
  threadId: null,
  messageId: MessageId.make("m1"),
});

/** The in-memory record of `write("k1")`, by hob, its reply's scope and key. */
const K1 = "hob reply:m1 k1";

describe("Charm call runner", () => {
  // covers IN-003, EX-003
  it("[TC-OR-074] never settles a key's later sending from a read-back that started for an earlier one", async () => {
    const rows = new Map<string, CharmCall>();
    const result = await Effect.gen(function* () {
      const lookedUp = yield* Deferred.make<void>();
      const found = yield* Deferred.make<boolean>();
      const secondSent = yield* Deferred.make<WriteOutcome>();
      // The first read-back waits on GitHub until the test lets it find the push; later ones find nothing.
      let reads = 0;
      const runner = yield* makeCharmCallRunner("GitHub", {
        github_push: () =>
          Effect.gen(function* () {
            reads += 1;
            if (reads > 1) return false;
            yield* Deferred.succeed(lookedUp, undefined);
            return yield* Deferred.await(found);
          }),
      });
      const first = yield* runner
        .run(write("k1"), Effect.succeed({ _tag: "Uncertain", text: "No answer." }))
        .pipe(Effect.scoped, Effect.forkChild);
      yield* Deferred.await(lookedUp);
      // While GitHub is read, the user settles the first sending as not sent, and the hob sends the key again.
      const stored = rows.get(K1);
      if (stored === undefined) throw new Error("expected the first sending to be recorded");
      rows.set(K1, new CharmCall({ ...stored, state: "not-sent", result: "The user settled it as not sent." }));
      const second = yield* runner.run(write("k1"), Deferred.await(secondSent)).pipe(Effect.scoped, Effect.forkChild);
      yield* Effect.yieldNow;
      const secondAttempt = rows.get(K1)?.attempt;
      // The first read-back finds the first push now: it must not settle the second sending.
      yield* Deferred.succeed(found, true);
      const firstOutcome = yield* Fiber.join(first);
      const whileSending = rows.get(K1);
      yield* Deferred.succeed(secondSent, { _tag: "Applied", text: "Pushed again." } as const);
      const secondOutcome = yield* Fiber.join(second);
      return {
        firstAttempt: stored.attempt,
        secondAttempt,
        firstOutcome,
        whileSending,
        secondOutcome,
        final: Option.fromUndefinedOr(rows.get(K1)),
      };
    }).pipe(Effect.scoped, Effect.provide(memoryCharmCalls(rows)), Effect.runPromise);

    expect(result.secondAttempt).toBeDefined();
    expect(result.secondAttempt).not.toBe(result.firstAttempt);
    expect(result.firstOutcome._tag).toBe("Uncertain");
    expect(result.whileSending).toMatchObject({ attempt: result.secondAttempt, state: "sending", result: null });
    expect(result.secondOutcome).toEqual({ _tag: "Applied", text: "Pushed again." });
    expect(Option.getOrThrow(result.final)).toMatchObject({ state: "applied", result: "Pushed again." });
  });

  // covers EX-004, OR-001
  it("[TC-OR-426] keeps reading an uncertain call back after its reply's calls move to the Task the reply started", async () => {
    const rows = new Map<string, CharmCall>();
    const final = await Effect.gen(function* () {
      // GitHub shows the push only after the reply has started its Task.
      let onGitHub = false;
      const runner = yield* makeCharmCallRunner("GitHub", { github_push: () => Effect.succeed(onGitHub) });
      // The runner's startup read-back of calls left unsettled finds none yet.
      yield* Effect.yieldNow;
      const outcome = yield* runner
        .run(write("k1"), Effect.succeed({ _tag: "Uncertain", text: "No answer." }))
        .pipe(Effect.scoped);
      expect(outcome._tag).toBe("Uncertain");
      // start_quest moves the reply's calls to the Task's work, as the Task tool ledger does.
      const stored = rows.get(K1);
      if (stored === undefined) throw new Error("expected the sending to be recorded");
      rows.delete(K1);
      rows.set("hob task:q1 k1", new CharmCall({ ...stored, scope: "task:q1" }));
      onGitHub = true;
      yield* TestClock.adjust("20 seconds");
      return rows.get("hob task:q1 k1");
    }).pipe(Effect.scoped, Effect.provide([memoryCharmCalls(rows), TestClock.layer()]), Effect.runPromise);

    expect(final).toMatchObject({ scope: "task:q1", state: "applied", result: "Pushed." });
  });
});
