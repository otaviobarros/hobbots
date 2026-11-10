import { ChatService, HobAdmission, HobbotsRepository, HobLifecycle, HobTools } from "@hobbots/agents";
import { Agent, AgentId, type MessageId, type ThreadId } from "@hobbots/domain";
import { HobbotsRepositoryLive } from "@hobbots/persistence";
import { TestDatabase } from "@hobbots/persistence/testing";
import { FakeRuntimeLayer } from "@hobbots/runtimes";
import { Effect, Layer, Schedule } from "effect";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { EventBus } from "../src/event-bus.ts";

// ThreadRun through the service (ADR 037, #1371): random sends, Send now, wakes, stops and restarts
// against one thread, after which every message must have run once, in order, and the thread be free.

const HOB_ID = AgentId.make("aldric");
const at = "2026-01-01T00:00:00.000Z";

const summonHob = HobbotsRepository.use((repo) =>
  repo.insertAgent(
    new Agent({
      id: HOB_ID,
      name: "Aldric",
      roleTitle: "Guide",
      runtime: "claude-code",
      model: null,
      effort: null,
      instructions: "",
      lookSeed: 4821,
      lookColor: "violet",
      configVersion: 1,
      createdAt: at,
    }),
  ),
);

/** What outlives a restart: the database, and the services around the chat. */
const world = Layer.mergeAll(
  Layer.effectDiscard(summonHob).pipe(Layer.provideMerge(HobbotsRepositoryLive.pipe(Layer.provideMerge(TestDatabase)))),
  EventBus.layer,
  HobAdmission.layer,
  // Slow enough that later messages queue behind a running reply.
  FakeRuntimeLayer({ delay: "15 millis" }),
);

/** One life of the process: its chat holds every run in memory, so a restart starts each idle. */
const life = HobLifecycle.layer.pipe(Layer.provideMerge(ChatService.layer.pipe(Layer.provide(HobTools.chatOnly))));

type Op =
  | { readonly _tag: "Send" }
  | { readonly _tag: "SendNow" }
  | { readonly _tag: "Stop" }
  | { readonly _tag: "Wake" }
  // A stop and a wake at once, as when work arrives for the hob while you press Stop.
  | { readonly _tag: "StopAndWake" }
  | { readonly _tag: "Pause"; readonly millis: number }
  | { readonly _tag: "Restart" };

const ops: fc.Arbitrary<Op> = fc.oneof(
  { weight: 4, arbitrary: fc.constant({ _tag: "Send" } as const) },
  fc.constant({ _tag: "SendNow" } as const),
  fc.constant({ _tag: "Stop" } as const),
  fc.constant({ _tag: "Wake" } as const),
  fc.constant({ _tag: "StopAndWake" } as const),
  { weight: 2, arbitrary: fc.integer({ min: 1, max: 30 }).map((millis) => ({ _tag: "Pause", millis }) as const) },
  fc.constant({ _tag: "Restart" } as const),
);

// Waits until every message has its reply, nothing streams or waits in the queue, and no turn runs.
const settled = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const repo = yield* HobbotsRepository;
    const chat = yield* ChatService;
    const messages = yield* repo.listMessages(threadId);
    const active = yield* chat.activeThreads;
    const unfinished = messages.some((m) => m.status === "streaming" || m.status === "queued");
    const unanswered = messages.length > 0 && messages.at(-1)?.role !== "assistant";
    if (unfinished || unanswered || active.length > 0) return yield* Effect.fail("busy" as const);
  }).pipe(Effect.retry(Schedule.spaced("5 millis")), Effect.timeout("5 seconds"));

interface Outcome {
  readonly sent: ReadonlyArray<string>;
  readonly chosen: ReadonlyArray<string>;
  readonly transcript: ReadonlyArray<readonly [string, string, string]>;
  /** How a prompt sent once all had settled ended: the thread must not be left busy for good. */
  readonly after: ReadonlyArray<readonly [string, string, string]>;
}

const play = (script: ReadonlyArray<Op>) =>
  Effect.gen(function* () {
    const sent: Array<{ readonly id: MessageId; readonly text: string }> = [];
    const chosen: Array<string> = [];
    let threadId: ThreadId | undefined;
    let remaining = [...script];
    // Each life runs ops until a restart, which closes its scope and so ends the turns it holds.
    while (true) {
      const restarted = yield* Effect.gen(function* () {
        const chat = yield* ChatService;
        if (threadId === undefined) threadId = (yield* chat.createThread(HOB_ID)).id;
        const thread = threadId;
        while (remaining.length > 0) {
          const [op, ...rest] = remaining as [Op, ...Array<Op>];
          remaining = rest;
          switch (op._tag) {
            case "Send": {
              const text = `m${sent.length}`;
              const { userMessage } = yield* chat.sendPrompt(thread, text);
              sent.push({ id: userMessage.id, text });
              break;
            }
            case "SendNow": {
              const last = sent.at(-1);
              if (last === undefined) break;
              // Refused when the message already started, as when you press it too late.
              const picked = yield* chat.sendNow(thread, last.id).pipe(
                Effect.as(true),
                Effect.catch(() => Effect.succeed(false)),
              );
              if (picked) chosen.push(last.text);
              break;
            }
            case "Stop":
              yield* chat.stop(thread);
              break;
            case "Wake":
              yield* chat.wake(thread);
              break;
            case "StopAndWake":
              yield* Effect.all([chat.stop(thread), chat.wake(thread)], { concurrency: "unbounded", discard: true });
              break;
            case "Pause":
              yield* Effect.sleep(`${op.millis} millis`);
              break;
            case "Restart":
              return true;
          }
        }
        yield* settled(thread);
        const repo = yield* HobbotsRepository;
        const transcript = (yield* repo.listMessages(thread)).map((m) => [m.role, m.content, m.status] as const);
        yield* chat.sendPrompt(thread, "after");
        yield* settled(thread);
        const after = (yield* repo.listMessages(thread)).slice(-2).map((m) => [m.role, m.content, m.status] as const);
        return { transcript, after } as const;
      }).pipe(Effect.provide(life), Effect.scoped);
      if (restarted !== true) return { sent: sent.map((s) => s.text), chosen, ...restarted } satisfies Outcome;
    }
  }).pipe(Effect.provide(world), Effect.scoped);

/** Each user message's text, in the order they ran. */
const ran = (outcome: Outcome) => outcome.transcript.filter(([role]) => role === "user").map(([, text]) => text);

describe("a thread's run through the chat", () => {
  it("runs every message once, in order, and frees the thread, whatever sends, stops, wakes and restarts do", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(ops, { minLength: 1, maxLength: 12 }), async (script) => {
        const outcome = await Effect.runPromise(play(script));
        // Every message ran exactly once, and each got one reply that is done.
        expect([...ran(outcome)].sort()).toEqual([...outcome.sent].sort());
        outcome.transcript.forEach(([role, , status], index) => {
          expect(role).toBe(index % 2 === 0 ? "user" : "assistant");
          expect(["complete", "stopped", "interrupted"]).toContain(status);
        });
        // Messages nobody picked with Send now keep the order they were sent in.
        const unpicked = (texts: ReadonlyArray<string>) => texts.filter((text) => !outcome.chosen.includes(text));
        expect(unpicked(ran(outcome))).toEqual(unpicked(outcome.sent));
        expect(outcome.after).toEqual([
          ["user", "after", "complete"],
          ["assistant", "Echo: after", "complete"],
        ]);
      }),
      { numRuns: 40 },
    );
  }, 120_000);
});
