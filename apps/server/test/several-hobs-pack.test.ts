import {
  AdditionalRuntimes,
  ApprovalService,
  ChapterService,
  ChatService,
  GrantService,
  HobAdmission,
  HobbotsRepository,
  HobTools,
  MemoryCapture,
  MemoryStore,
  type PromptRequest,
  RuntimeAdapter,
  type RuntimeAdapterShape,
  ChannelMemberRepository,
} from "@hobbots/agents";
import {
  Agent,
  AgentId,
  hobActor,
  isInProgress,
  liveSession,
  MemoryPath,
  type MemoryScope,
  type Message,
  OWNER_ACTOR,
  type RuntimeKind,
  roleFields,
  Channel,
  type ChannelId,
} from "@hobbots/domain";
import { makeMemoryStoreFake } from "@hobbots/memory/testing";
import {
  ApprovalRepositoryLive,
  ChapterRepositoryLive,
  EventJournal,
  GrantRepositoryLive,
  HobbotsRepositoryLive,
  MemoryCaptureLive,
  TaskRepositoryLive,
  ChannelMemberRepositoryLive,
  UserRepositoryLive,
} from "@hobbots/persistence";
import { TestDatabase } from "@hobbots/persistence/testing";
import { makeFakeRuntime } from "@hobbots/runtimes";
import { Effect, Layer, ManagedRuntime, Option } from "effect";
import { SqlClient } from "effect/sql";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventBus } from "../src/event-bus.ts";
import { NodeFolderChecks } from "../src/folders.ts";

// Issue #1465 (ADR 039, The context pack with several hobs): in a camp two hobs speak in, a hob's
// new session starts from a pack that says who is here and why it answers, names every speaker and
// carries its own memory brief, never the other hob's; a resumed session hears only what others
// said since it last spoke. Issue #1466 (ADR 039, Memory in a shared channel): each hob's memory keeps
// its own turns and the messages it took, and a private camp none. On Claude Code and on Codex alike.
// Until the floor runs the mentioned hob's turn (#1461), a test hands the camp from one hob to the other.

const NOW = "2026-11-14T00:00:00.000Z";
const WREN = AgentId.make("wren");
const QUILL = AgentId.make("quill");

// What each runtime was asked, in order.
let asked: Record<RuntimeKind, Array<PromptRequest>>;

const recorded = (runtime: RuntimeKind, fake: RuntimeAdapterShape): RuntimeAdapterShape => ({
  ...fake,
  sendPrompt: (request) => {
    asked[runtime].push(request);
    // The fake echoes what it is sent: echoing only the prompt keeps each reply what its hob said,
    // not its own memory brief, which another hob would then read as part of the camp.
    return fake.sendPrompt({ ...request, briefing: null });
  },
});

const hubLayer = (memory: MemoryStore["Service"]) =>
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
          ChannelMemberRepositoryLive,
          UserRepositoryLive,
          ChapterRepositoryLive,
          ApprovalRepositoryLive,
          GrantRepositoryLive,
          TaskRepositoryLive,
          EventJournal.layer,
        ).pipe(Layer.provideMerge(TestDatabase)),
        EventBus.layer,
        HobAdmission.layer,
        NodeFolderChecks,
        Layer.succeed(MemoryStore, memory),
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
let memory: ReturnType<typeof makeMemoryStoreFake>;

afterEach(async () => {
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

const lesson = (store: MemoryStore["Service"], scope: MemoryScope, text: string) =>
  Effect.runPromise(
    store.write(
      { _tag: "You" },
      scope,
      { path: MemoryPath.make("notes/lesson.md"), markdown: `# Lesson\n\n${text}`, tags: [], pinned: false },
      { _tag: "Any" },
    ),
  );

/** A hub with Wren and Quill, both thinking with `runtime`, each remembering its own lesson, and a camp of Wren's that Quill joined. */
const start = async (runtime: RuntimeKind): Promise<ChannelId> => {
  asked = { "claude-code": [], codex: [] };
  memory = makeMemoryStoreFake();
  await lesson(memory.store, { _tag: "Hob", agentId: WREN }, "Wren keeps the market's ledger.");
  await lesson(memory.store, { _tag: "Hob", agentId: QUILL }, "Quill writes in short sentences.");
  hub = ManagedRuntime.make(hubLayer(memory.store));
  return run(
    Effect.gen(function* () {
      const repo = yield* HobbotsRepository;
      yield* repo.insertAgent(hob(WREN, "Wren", runtime));
      yield* repo.insertAgent(hob(QUILL, "Quill", runtime));
      const chat = yield* ChatService;
      // Wren's first channel is its direct message; the next one is a camp, which Quill joins.
      yield* chat.createChannel(WREN);
      const camp = yield* chat.createChannel(WREN);
      yield* (yield* ChannelMemberRepository).add(camp.id, hobActor(QUILL), OWNER_ACTOR);
      return camp.id;
    }),
  );
};

/** Sends `content` and waits for the turn to end. */
const say = async (id: ChannelId, content: string): Promise<Message> => {
  await run(ChatService.use((chat) => chat.sendPrompt(id, content)));
  return vi.waitFor(async () => {
    const all = await run(HobbotsRepository.use((repo) => repo.listMessages(id)));
    expect(all.some((m) => isInProgress(m.status) || m.status === "queued")).toBe(false);
    return all.at(-1) as Message;
  });
};

/** Lets `agentId` answer the camp's next turns, as the floor will (#1461). */
const handTo = (id: ChannelId, agentId: AgentId) =>
  run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE channels SET agent_id = ${agentId} WHERE id = ${id}`;
    }),
  );

const sessionOf = (id: ChannelId, runtime: RuntimeKind, agentId: AgentId) =>
  run(
    HobbotsRepository.use((repo) => repo.findChannel(id)).pipe(
      Effect.map((channel) => liveSession(Option.getOrThrow(channel), runtime, agentId)),
    ),
  );

describe("the context pack with several hobs", () => {
  // covers ADR 039 (The context pack with several hobs), RT-001
  it.each<RuntimeKind>(["claude-code", "codex"])(
    "on %s, each hob's pack names who is here, why it answers and every speaker, with only its own memory (#1465)",
    async (runtime) => {
      const id = await start(runtime);
      await say(id, "@Wren our stall is number 12.");
      const first = asked[runtime][0] as PromptRequest;
      expect(first.sessionId).toBeNull();
      expect(first.briefing).toContain("Wren keeps the market's ledger.");
      expect(first.briefing).not.toContain("Quill writes in short sentences.");
      expect(first.briefing).toContain("Why you are answering now: Owner mentioned you.");

      await handTo(id, QUILL);
      await say(id, "@Quill write the sign for it.");
      const quill = asked[runtime][1] as PromptRequest;
      // Quill has not spoken here: a new session from the pack, with its own memory and never Wren's.
      expect(quill.sessionId).toBeNull();
      expect(quill.briefing).toContain("Quill writes in short sentences.");
      expect(quill.briefing).not.toContain("Wren keeps the market's ledger.");
      expect(quill.briefing).toContain(
        [
          "## Who is here",
          "You are Quill.",
          "Why you are answering now: Owner mentioned you.",
          "Its members:",
          "- Owner (person, owner)",
          "- Wren (hob)",
          "- Quill (hob, you)",
        ].join("\n"),
      );
      expect(quill.briefing).toContain("**Owner (person):**\n> @Wren our stall is number 12.");
      expect(quill.briefing).toMatch(/\*\*Wren \(hob\):\*\*\n> /);
      expect(quill.briefing).not.toContain("**User:**");

      await handTo(id, WREN);
      await say(id, "@Wren how big should it be?");
      const wren = asked[runtime][2] as PromptRequest;
      // Wren resumes its own session and hears only what was said since it last spoke.
      expect(wren.sessionId).toBe((await sessionOf(id, runtime, WREN))?.sessionId);
      expect(wren.briefing).toContain("Why you are answering now: Owner mentioned you.");
      expect(wren.briefing).toContain("## Since you last spoke");
      expect(wren.briefing).toContain("**Owner (person):**\n> @Quill write the sign for it.");
      expect(wren.briefing).toMatch(/\*\*Quill \(hob\):\*\*\n> /);
      expect(wren.briefing).not.toContain("our stall is number 12");
      expect(wren.briefing).not.toContain("Quill writes in short sentences.");
    },
  );
});

/** One round of the capture worker over the hub's own journal, as the hub runs it while memory is on. */
const captureRound = () =>
  run(
    MemoryCapture.use((capture) => capture.runOnce).pipe(
      Effect.provide(
        MemoryCapture.make.pipe(
          Layer.provide(Layer.merge(MemoryCaptureLive, Layer.succeed(MemoryStore, memory.store))),
        ),
      ),
    ),
  );

/** What `agentId`'s own memory keeps of the camp's session, as text. */
const keptBy = (agentId: AgentId, id: ChannelId) =>
  memory.controls.captured({ _tag: "Hob", agentId }, id).map((item) => `${item.kind}: ${item.text}`);

describe("memory in a shared channel", () => {
  // covers ADR 039 (Memory in a shared channel), ADR 037 (A camp is a channel with a kind), RT-001
  it.each<RuntimeKind>(["claude-code", "codex"])(
    "on %s, each hob's memory keeps its own turns and the messages it took, and a private camp none (#1466)",
    async (runtime) => {
      const id = await start(runtime);
      // Memory is on from the start: the worker holds the journal from its head.
      expect(await captureRound()).toBe(true);
      await say(id, "@Wren our stall is number 12.");
      await handTo(id, QUILL);
      await say(id, "@Quill write the sign for it.");
      expect(await captureRound()).toBe(true);

      const wren = keptBy(WREN, id);
      const quill = keptBy(QUILL, id);
      expect(wren).toContain(`message: @Wren our stall is number 12.\n\n(from user ${OWNER_ACTOR.id})`);
      expect(wren.filter((item) => item.startsWith("reply: "))).toHaveLength(1);
      expect(wren.some((item) => item.includes("write the sign"))).toBe(false);
      expect(quill).toContain(`message: @Quill write the sign for it.\n\n(from user ${OWNER_ACTOR.id})`);
      expect(quill.filter((item) => item.startsWith("reply: "))).toHaveLength(1);
      expect(quill.some((item) => item.includes("stall is number 12"))).toBe(false);

      // Made private, the camp keeps every member hob's memory out.
      await run(
        HobbotsRepository.use((repo) =>
          Effect.flatMap(repo.findChannel(id), (channel) =>
            repo.upsertChannel(new Channel({ ...Option.getOrThrow(channel), kind: "camp", private: true })),
          ),
        ),
      );
      await say(id, "@Quill Ada earns 9000.");
      await handTo(id, WREN);
      await say(id, "@Wren Ada earns 9000 too.");
      expect(await captureRound()).toBe(true);
      for (const agentId of [WREN, QUILL]) {
        expect(keptBy(agentId, id).some((item) => item.includes("9000"))).toBe(false);
      }
      expect(keptBy(WREN, id)).toEqual(wren);
      expect(keptBy(QUILL, id)).toEqual(quill);
    },
  );
});
