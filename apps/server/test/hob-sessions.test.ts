import {
  AdditionalRuntimes,
  ApprovalService,
  ChapterService,
  ChatService,
  GrantService,
  HobAdmission,
  HobbotsRepository,
  HobTools,
  type PromptRequest,
  RuntimeAdapter,
  type RuntimeAdapterShape,
  ThreadMemberRepository,
} from "@hobbots/agents";
import {
  Agent,
  AgentId,
  hobActor,
  isInProgress,
  liveSession,
  type Message,
  OWNER_ACTOR,
  type RuntimeKind,
  roleFields,
  type Thread,
  type ThreadId,
} from "@hobbots/domain";
import {
  ApprovalRepositoryLive,
  ChapterRepositoryLive,
  EventJournal,
  GrantRepositoryLive,
  HobbotsRepositoryLive,
  TaskRepositoryLive,
  ThreadMemberRepositoryLive,
} from "@hobbots/persistence";
import { TestDatabase } from "@hobbots/persistence/testing";
import { makeFakeRuntime } from "@hobbots/runtimes";
import { Effect, Layer, ManagedRuntime, Option, Stream } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventBus } from "../src/event-bus.ts";
import { NodeFolderChecks } from "../src/folders.ts";

// Issue #1464 (ADR 039): a runtime session belongs to one hob. In a thread two hobs speak in, each
// resumes only its own session, on Claude Code and on Codex alike, and a hob that has not spoken in
// the live chapter starts a new session from the context pack. The test passes the floor from one hob
// to the other by @mention (#1461).

const NOW = "2026-11-11T00:00:00.000Z";
const WREN = AgentId.make("wren");
const QUILL = AgentId.make("quill");

// What each runtime was asked, in order.
let asked: Record<RuntimeKind, Array<PromptRequest>>;
// While set, a prompt waits for it before the runtime answers.
let held: Promise<void> | null = null;

const recorded = (runtime: RuntimeKind, fake: RuntimeAdapterShape): RuntimeAdapterShape => ({
  ...fake,
  sendPrompt: (request) => {
    asked[runtime].push(request);
    const hold = held;
    return hold === null
      ? fake.sendPrompt(request)
      : Stream.unwrap(Effect.promise(() => hold).pipe(Effect.as(fake.sendPrompt(request))));
  },
});

const hubLayer = () =>
  Layer.mergeAll(
    ChatService.layer.pipe(Layer.provide(HobTools.chatOnly)),
    ChapterService.layer,
    ApprovalService.layer,
    GrantService.layer,
  ).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.mergeAll(
          HobbotsRepositoryLive,
          ChapterRepositoryLive,
          ApprovalRepositoryLive,
          GrantRepositoryLive,
          TaskRepositoryLive,
          ThreadMemberRepositoryLive,
          EventJournal.layer,
        ).pipe(Layer.provideMerge(TestDatabase)),
        EventBus.layer,
        HobAdmission.layer,
        NodeFolderChecks,
        Layer.succeed(RuntimeAdapter, recorded("claude-code", makeFakeRuntime())),
        Layer.succeed(
          AdditionalRuntimes,
          new Map([["codex", recorded("codex", makeFakeRuntime({ runtime: "codex" }))]]),
        ),
      ),
    ),
  );

type Hub = ManagedRuntime.ManagedRuntime<
  Layer.Success<ReturnType<typeof hubLayer>>,
  Layer.Error<ReturnType<typeof hubLayer>>
>;
let hub: Hub | undefined;

afterEach(async () => {
  held = null;
  await hub?.dispose();
  hub = undefined;
});

const run = <A, E>(effect: Effect.Effect<A, E, Layer.Success<ReturnType<typeof hubLayer>>>) =>
  (hub as Hub).runPromise(effect);

const hob = (id: AgentId, name: string, runtime: RuntimeKind) =>
  new Agent({
    id,
    name,
    ...roleFields("writer"),
    runtime,
    model: null,
    effort: null,
    instructions: "",
    lookSeed: 7,
    lookColor: "moss",
    configVersion: 1,
    createdAt: NOW,
  });

/** A hub with Wren and Quill, both thinking with `runtime`, and a camp of Wren's, Wren alone in it. */
const start = async (runtime: RuntimeKind): Promise<ThreadId> => {
  asked = { "claude-code": [], codex: [] };
  hub = ManagedRuntime.make(hubLayer());
  return run(
    Effect.gen(function* () {
      const repo = yield* HobbotsRepository;
      yield* repo.insertAgent(hob(WREN, "Wren", runtime));
      yield* repo.insertAgent(hob(QUILL, "Quill", runtime));
      const chat = yield* ChatService;
      // Wren's first thread is the direct chat; a second one is a camp, which other hobs can join.
      yield* chat.createThread(WREN);
      return (yield* chat.createThread(WREN)).id;
    }),
  );
};

const thread = (id: ThreadId): Promise<Thread> =>
  run(HobbotsRepository.use((repo) => repo.findThread(id)).pipe(Effect.map(Option.getOrThrow)));

/** Sends `content` and waits for the turn to end. */
const say = async (id: ThreadId, content: string): Promise<Message> => {
  await run(ChatService.use((chat) => chat.sendPrompt(id, content)));
  return vi.waitFor(async () => {
    const all = await run(HobbotsRepository.use((repo) => repo.listMessages(id)));
    expect(all.some((m) => isInProgress(m.status) || m.status === "queued")).toBe(false);
    return all.at(-1) as Message;
  });
};

/** Brings Quill into the camp, so a mention of Quill gives Quill the floor. */
const join = (id: ThreadId) =>
  run(ThreadMemberRepository.use((members) => members.add(id, hobActor(QUILL), OWNER_ACTOR)));

describe("runtime sessions keyed by hob", () => {
  // covers ADR 039 (The context pack with several hobs), RT-001
  it.each<RuntimeKind>(["claude-code", "codex"])(
    "[TC-CH-1464-01] on %s, each hob in a thread resumes its own session, and a new one starts from the pack",
    async (runtime) => {
      const id = await start(runtime);
      await say(id, "My cat is called Miso.");
      const wren = liveSession(await thread(id), runtime, WREN);
      expect(wren?.sessionId).toMatch(/^fake-/);
      expect(liveSession(await thread(id), runtime, QUILL)).toBeUndefined();

      await join(id);
      await say(id, "@quill what should I plant?");
      const fresh = asked[runtime][1] as PromptRequest;
      // Quill has not spoken in the chapter: a new session, briefed from the pack, never Wren's.
      expect(fresh.sessionId).toBeNull();
      expect(fresh.briefing).toContain("My cat is called Miso.");
      const quill = liveSession(await thread(id), runtime, QUILL);
      expect(quill?.sessionId).toMatch(/^fake-/);
      expect(quill?.sessionId).not.toBe(wren?.sessionId);
      // Wren's session is kept as it was.
      expect(liveSession(await thread(id), runtime, WREN)).toEqual(wren);

      await say(id, "@quill and when?");
      expect(asked[runtime][2]?.sessionId).toBe(quill?.sessionId);

      await say(id, "@wren how old is she?");
      expect(asked[runtime][3]?.sessionId).toBe(wren?.sessionId);
      expect(asked[runtime].map((request) => request.sessionId)).toEqual([
        null,
        null,
        quill?.sessionId,
        wren?.sessionId,
      ]);
      const sessions = (await thread(id)).sessions;
      expect(sessions.map((s) => [s.runtime, s.agentId, s.sessionId])).toEqual([
        [runtime, WREN, wren?.sessionId],
        [runtime, QUILL, quill?.sessionId],
      ]);
      // Each session has seen the thread through its own hob's last reply.
      const messages = await run(HobbotsRepository.use((repo) => repo.listMessages(id)));
      const lastReplyOf = (agentId: AgentId) =>
        messages.findLast((m) => m.role === "assistant" && m.actor?.kind === "hob" && m.actor.id === agentId)?.id;
      expect(sessions.map((s) => s.seenThrough)).toEqual([lastReplyOf(WREN), lastReplyOf(QUILL)]);
    },
  );
});
