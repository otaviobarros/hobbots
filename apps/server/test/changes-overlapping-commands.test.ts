import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ActivityRecorder, makeRedactor, type RuntimeEvent, type ToolStartedEvent } from "@hobbots/agents";
import type { AttemptId } from "@hobbots/domain";
import { Deferred, Effect, Exit, Queue, Scope, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { endedActivity, hub, say, setUp, treeWhen } from "./workbench-hub.ts";

// Issue #595: which turn a change belongs to when two turns' tool calls interleave in one folder. The
// recorder runs two turns whose tool calls the test plays one event at a time, so every order is exact,
// on SQLite or PostgreSQL (TestDatabase).

/** Two Attempts of one Quest, from a plan of two steps that did nothing. */
const twoAttempts = async () => {
  const hubbed = setUp({ "x.txt": "x\n" });
  await hubbed.run(
    say(["Plan", hub("plan_steps", { key: "plan", steps: [{ brief: "One" }, { brief: "Two" }] })].join("\n")),
  );
  const tree = await hubbed.run(
    treeWhen(
      (each) =>
        each.tasks.filter((task) => task.parentId !== null).every((task) => task.state === "completed") &&
        each.attempts.length >= 3,
    ),
  );
  const [one, two] = tree.tasks
    .filter((task) => task.parentId !== null)
    .map((task) => tree.attempts.find((attempt) => attempt.taskId === task.id)?.id as AttemptId);
  return { ...hubbed, one: one as AttemptId, two: two as AttemptId };
};

/** A turn on `attemptId` whose runtime the test plays: each call starts, then ends, when the test says. */
const playedTurn = (folder: string, attemptId: AttemptId) =>
  Effect.gen(function* () {
    const recorder = yield* ActivityRecorder;
    const scope = yield* Scope.make();
    const activity = yield* Scope.provide(scope)(
      recorder.forTurn({ folders: [folder], attempt: Effect.succeed(attemptId), redactor: makeRedactor() }),
    );
    const queue = yield* Queue.unbounded<RuntimeEvent>();
    const seen = new Map<string, Deferred.Deferred<void>>();
    let recordStart: (event: ToolStartedEvent) => Effect.Effect<boolean> = () => Effect.succeed(false);
    const events = activity.run(
      {
        prompt: "",
        sessionId: null,
        instructions: "",
        instructionsChanged: false,
        model: null,
        effort: null,
        tools: null,
        recordToolStart: () => Effect.succeed(true),
      },
      (request) => {
        recordStart = request.recordToolStart ?? recordStart;
        return Stream.fromQueue(queue);
      },
    );
    yield* Effect.forkIn(
      Stream.runForEach(events, (event) =>
        event._tag === "TextDelta"
          ? Deferred.succeed(seen.get(event.text) as Deferred.Deferred<void>, undefined)
          : Effect.void,
      ),
      scope,
    );
    let marks = 0;
    /** Sends an event and waits until the recorder has handled it. */
    const send = (event: RuntimeEvent) =>
      Effect.gen(function* () {
        const mark = `mark-${++marks}`;
        const done = yield* Deferred.make<void>();
        seen.set(mark, done);
        yield* Queue.offerAll(queue, [event, { _tag: "TextDelta", text: mark }]);
        yield* Deferred.await(done);
      });
    // A call's start is recorded before it runs, as every runtime does, then reported.
    const start = (event: ToolStartedEvent) => Effect.andThen(recordStart(event), send(event));
    return {
      command: (id: string) =>
        start({
          _tag: "ToolStarted",
          id,
          tool: "Bash",
          operation: "run-commands",
          targets: [folder],
          label: "Running a script",
          command: { line: `./${id}.sh`, folder, sandboxed: true, liveOutput: false },
        }),
      edit: (id: string, path: string) =>
        start({
          _tag: "ToolStarted",
          id,
          tool: "Edit",
          operation: "edit-files",
          targets: [join(folder, path)],
          label: `Editing ${path}`,
        }),
      finish: (id: string) => send({ _tag: "ToolFinished", id, failed: false }),
      end: Scope.close(scope, Exit.void),
    };
  });

const changesOf = (attemptId: AttemptId) =>
  Effect.map(endedActivity(attemptId), (activity) =>
    activity.changes.map(({ path, sharedWith }) => ({ path, sharedWith: [...sharedWith] })),
  );

describe("changes when two turns' tool calls interleave in one folder", () => {
  // covers UX-002, ADR 023
  it("[TC-RT-110] a file another turn edited before a command ran is still the command's when the command changes it", async () => {
    const { run: inHub, folder, one, two } = await twoAttempts();
    const changes = await inHub(
      Effect.gen(function* () {
        const a = yield* playedTurn(folder, one);
        const b = yield* playedTurn(folder, two);
        // B edits x.txt with a file tool and ends.
        yield* b.edit("b-edit", "x.txt");
        writeFileSync(join(folder, "x.txt"), "x by B\n");
        yield* b.finish("b-edit");
        yield* b.end;
        // A's command then rewrites x.txt, while B edits nothing.
        yield* a.command("a-run");
        writeFileSync(join(folder, "x.txt"), "x by A\n");
        yield* a.finish("a-run");
        yield* a.end;
        return { a: yield* changesOf(one), b: yield* changesOf(two) };
      }),
    );

    expect(changes.a.map(({ path }) => path)).toEqual(["x.txt"]);
    expect(changes.b.map(({ path }) => path)).toEqual(["x.txt"]);
  }, 30_000);

  // covers UX-002, ADR 023
  it("[TC-RT-111] a file another turn's file tool edits while a command runs is not the command's", async () => {
    const { run: inHub, folder, one, two } = await twoAttempts();
    const changes = await inHub(
      Effect.gen(function* () {
        const a = yield* playedTurn(folder, one);
        const b = yield* playedTurn(folder, two);
        yield* a.command("a-run");
        writeFileSync(join(folder, "a.txt"), "a\n");
        // B's file tool starts while A's command runs, and is still writing when that command ends.
        yield* b.edit("b-edit", "b.txt");
        writeFileSync(join(folder, "b.txt"), "b\n");
        yield* a.finish("a-run");
        yield* a.end;
        yield* b.finish("b-edit");
        yield* b.end;
        return { a: yield* changesOf(one), b: yield* changesOf(two) };
      }),
    );

    expect(changes.a).toEqual([{ path: "a.txt", sharedWith: [] }]);
    expect(changes.b).toEqual([{ path: "b.txt", sharedWith: [] }]);
  }, 30_000);

  // covers UX-002, ADR 023
  it("[TC-RT-112] a file that two running commands may each have made is labeled shared, even when one turn settles first", async () => {
    const { run: inHub, folder, one, two } = await twoAttempts();
    const changes = await inHub(
      Effect.gen(function* () {
        const a = yield* playedTurn(folder, one);
        const b = yield* playedTurn(folder, two);
        yield* b.command("b-run");
        yield* a.command("a-run");
        writeFileSync(join(folder, "b.txt"), "b\n");
        writeFileSync(join(folder, "a.txt"), "a\n");
        // A's command and turn end while B's command still runs.
        yield* a.finish("a-run");
        yield* a.end;
        const a1 = yield* changesOf(one);
        yield* b.finish("b-run");
        yield* b.end;
        return { a: a1, b: yield* changesOf(two) };
      }),
    );

    // Neither turn can tell whose each file is, so each records both, each labeled as shared.
    expect(changes.a).toEqual([
      { path: "a.txt", sharedWith: [two] },
      { path: "b.txt", sharedWith: [two] },
    ]);
    expect(changes.b).toEqual([
      { path: "a.txt", sharedWith: [one] },
      { path: "b.txt", sharedWith: [one] },
    ]);
  }, 30_000);
});
