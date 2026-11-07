import { Deferred, Effect, Ref, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { stoppableWait } from "../src/command-wait.ts";
import type { RuntimeEvent } from "../src/runtime.ts";

/** A turn that answered, then waits on `ids` until it is stopped. */
const waitingTurn = (ids: ReadonlyArray<string>): Stream.Stream<RuntimeEvent> =>
  Stream.fromIterable<RuntimeEvent>([
    { _tag: "TextDelta", text: "Started it." },
    ...(ids.length === 0 ? [] : [{ _tag: "AwaitingCommands", ids } as const]),
  ]).pipe(Stream.concat(Stream.never));

const run = (events: Stream.Stream<RuntimeEvent>, stopAfter: number) =>
  Effect.gen(function* () {
    const stop = yield* Deferred.make<void>();
    const count = yield* Ref.make<number | null>(null);
    const seen: Array<RuntimeEvent> = [];
    yield* stoppableWait(events, stop, (n) => Ref.set(count, n)).pipe(
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          seen.push(event);
          if (seen.length === stopAfter) yield* Deferred.succeed(stop, undefined);
        }),
      ),
    );
    return { seen, count: yield* Ref.get(count) };
  }).pipe(Effect.runPromise);

describe("stoppableWait (#1056)", () => {
  it("ends a turn that only waits, reporting each command it waited on as stopped", async () => {
    const { seen, count } = await run(waitingTurn(["c1", "c2"]), 2);
    expect(seen.slice(2)).toEqual([
      { _tag: "ToolStopped", id: "c1" },
      { _tag: "ToolStopped", id: "c2" },
    ]);
    expect(count).toBe(2);
  });

  it("stops a turn that was not waiting without reporting any command", async () => {
    const { seen, count } = await run(waitingTurn([]), 1);
    expect(seen).toEqual([{ _tag: "TextDelta", text: "Started it." }]);
    expect(count).toBe(0);
  });

  it("leaves a turn that ends on its own as it was", async () => {
    const events = Stream.fromIterable<RuntimeEvent>([
      { _tag: "AwaitingCommands", ids: ["c1"] },
      { _tag: "ToolFinished", id: "c1", failed: false },
      { _tag: "TextDelta", text: "It ended." },
    ]);
    const { seen, count } = await run(events, 99);
    expect(seen.map((event) => event._tag)).toEqual(["AwaitingCommands", "ToolFinished", "TextDelta"]);
    expect(count).toBeNull();
  });
});
