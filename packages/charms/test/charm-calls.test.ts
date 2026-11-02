import { AgentId, CharmCall } from "@hobbots/domain";
import { Deferred, Effect, Fiber, Option } from "effect";
import { describe, expect, it } from "vitest";
import { type CharmWrite, makeCharmCallRunner, type WriteOutcome } from "../src/index.ts";
import { memoryCharmCalls } from "./support.ts";

const write = (key: string): CharmWrite => ({
  agentId: AgentId.make("hob"),
  tool: "github_push",
  key,
  input: { branch: "feat/x" },
  site: "github.com/octo/app refs/heads/feat/x",
  plan: { commit: "abc" },
  appliedText: "Pushed.",
  step: undefined,
  threadId: null,
  messageId: null,
});

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
      const runner = yield* makeCharmCallRunner({
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
      const stored = rows.get("hob k1");
      if (stored === undefined) throw new Error("expected the first sending to be recorded");
      rows.set("hob k1", new CharmCall({ ...stored, state: "not-sent", result: "The user settled it as not sent." }));
      const second = yield* runner.run(write("k1"), Deferred.await(secondSent)).pipe(Effect.scoped, Effect.forkChild);
      yield* Effect.yieldNow;
      const secondAttempt = rows.get("hob k1")?.attempt;
      // The first read-back finds the first push now: it must not settle the second sending.
      yield* Deferred.succeed(found, true);
      const firstOutcome = yield* Fiber.join(first);
      const whileSending = rows.get("hob k1");
      yield* Deferred.succeed(secondSent, { _tag: "Applied", text: "Pushed again." } as const);
      const secondOutcome = yield* Fiber.join(second);
      return {
        firstAttempt: stored.attempt,
        secondAttempt,
        firstOutcome,
        whileSending,
        secondOutcome,
        final: Option.fromUndefinedOr(rows.get("hob k1")),
      };
    }).pipe(Effect.scoped, Effect.provide(memoryCharmCalls(rows)), Effect.runPromise);

    expect(result.secondAttempt).toBeDefined();
    expect(result.secondAttempt).not.toBe(result.firstAttempt);
    expect(result.firstOutcome._tag).toBe("Uncertain");
    expect(result.whileSending).toMatchObject({ attempt: result.secondAttempt, state: "sending", result: null });
    expect(result.secondOutcome).toEqual({ _tag: "Applied", text: "Pushed again." });
    expect(Option.getOrThrow(result.final)).toMatchObject({ state: "applied", result: "Pushed again." });
  });
});
