import {
  AdditionalRuntimes,
  CampDrift,
  CampSuggestionService,
  ChapterService,
  ChatService,
  HobAdmission,
  HobbotsRepository,
  HobTools,
  HubDecider,
  type Judgment,
  PackReports,
  type PromptRequest,
  RecordPackSource,
  Records,
  RuntimeAdapter,
  type RuntimeAdapterShape,
} from "@hobbots/agents";
import {
  Agent,
  AgentId,
  CAMP_DRIFT_CONFIDENCE,
  CAMP_SUGGESTION_DECISIONS,
  type CampSuggestion,
  ChapterId,
  isInProgress,
  type Message,
  type RuntimeKind,
  roleFields,
  ThreadId,
} from "@hobbots/domain";
import {
  CampSuggestionRepositoryLive,
  ChapterRepositoryLive,
  EventJournal,
  HobbotsRepositoryLive,
  RecordRepositoryLive,
  TaskRepositoryLive,
} from "@hobbots/persistence";
import { TestDatabase } from "@hobbots/persistence/testing";
import { makeFakeRuntime } from "@hobbots/runtimes";
import { Effect, Layer, ManagedRuntime } from "effect";
import { SqlClient } from "effect/sql";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventBus } from "../src/event-bus.ts";
import { NodeFolderChecks } from "../src/folders.ts";

// Issue #1385 (ADR 037): a chapter moved into a camp goes on there, on every runtime: the camp's next
// turn starts a session from its pack, which carries the moved chapter's transcript, and the chat's
// starts afresh without it. A chat chapter grown past a threshold is suggested once, and Keep in chat
// keeps it from coming back. Once a chat chapter rests, the hub's brain may suggest it as a camp;
// under No AI no model is asked and the rule stands.

const NOW = "2026-11-12T00:00:00.000Z";
const WREN = AgentId.make("wren");

let asked: Record<RuntimeKind, Array<PromptRequest>>;
let judged: Array<Judgment<unknown>>;
const recorded = (runtime: RuntimeKind, fake: RuntimeAdapterShape): RuntimeAdapterShape => ({
  ...fake,
  sendPrompt: (request) => {
    asked[runtime].push(request);
    return fake.sendPrompt(request);
  },
});

/** The hub's brain, answering every judgment with `choice` at `confidence`, and remembering what it was asked. */
const brain = (choice: string, confidence: number) =>
  Layer.succeed(
    HubDecider,
    HubDecider.of({
      decide: (judgment) => {
        judged.push(judgment as Judgment<unknown>);
        return Effect.succeed({ choice: choice as typeof judgment.rule, confidence, by: "brain" });
      },
    }),
  );

const hubLayer = (decider: Layer.Layer<never> | Layer.Layer<HubDecider>) =>
  Layer.mergeAll(
    ChatService.layer.pipe(Layer.provide(HobTools.chatOnly)),
    ChapterService.layer,
    CampSuggestionService.layer,
    CampDrift.make,
  ).pipe(
    Layer.provideMerge(Layer.merge(RecordPackSource.pipe(Layer.provide(Records.layer)), Records.layer)),
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.mergeAll(
          HobbotsRepositoryLive,
          ChapterRepositoryLive,
          CampSuggestionRepositoryLive.pipe(Layer.provide(EventJournal.layer)),
          TaskRepositoryLive,
          RecordRepositoryLive,
          EventJournal.layer,
        ).pipe(Layer.provideMerge(TestDatabase)),
        EventBus.layer,
        HobAdmission.layer,
        NodeFolderChecks,
        PackReports.layer,
        decider,
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
  await hub?.dispose();
  hub = undefined;
});

const run = <A, E>(effect: Effect.Effect<A, E, Layer.Success<ReturnType<typeof hubLayer>>>) =>
  (hub as Hub).runPromise(effect);

/** A hub with Wren, thinking with `runtime`, and her chat. */
const start = async (runtime: RuntimeKind, decider: Layer.Layer<never> | Layer.Layer<HubDecider> = Layer.empty) => {
  asked = { "claude-code": [], codex: [] };
  judged = [];
  hub = ManagedRuntime.make(hubLayer(decider));
  return run(
    Effect.gen(function* () {
      const repo = yield* HobbotsRepository;
      yield* repo.insertAgent(
        new Agent({
          id: WREN,
          name: "Wren",
          ...roleFields("writer"),
          runtime,
          model: null,
          effort: null,
          instructions: "",
          lookSeed: 7,
          lookColor: "moss",
          configVersion: 1,
          createdAt: NOW,
        }),
      );
      return (yield* (yield* ChatService).createThread(WREN)).id;
    }),
  );
};

/** Sends `content` and waits for the turn to end. */
const say = async (id: ThreadId, content: string): Promise<Message> => {
  await run(ChatService.use((chat) => chat.sendPrompt(id, content)));
  return vi.waitFor(async () => {
    const all = await run(HobbotsRepository.use((repo) => repo.listMessages(id)));
    expect(all.some((m) => isInProgress(m.status) || m.status === "queued")).toBe(false);
    return all.at(-1) as Message;
  });
};

const startChapter = (id: ThreadId, chapter: string, title: string) =>
  run(ChapterService.use((chapters) => chapters.startChapter(id, { id: ChapterId.make(chapter), title })));

const GARDEN_CAMP = ThreadId.make("camp-garden");

const intoNewCamp = (id: ThreadId, chapter: string) =>
  run(
    ChatService.use((chat) =>
      chat.moveChapter(id, ChapterId.make(chapter), {
        _tag: "new",
        key: GARDEN_CAMP,
        title: "The garden",
        goal: "Plan the beds",
        private: false,
      }),
    ),
  );

const journaled = (type: string) =>
  run(
    EventJournal.use((journal) => journal.readAfter(0, 10_000)).pipe(
      Effect.map((entries) => entries.filter((entry) => entry.payload._tag === type)),
    ),
  );

describe("a chapter moved into a camp", () => {
  // covers ADR 037 (Moving a chapter into a camp moves it), CH-009, RT-001
  it.each<RuntimeKind>(["claude-code", "codex"])(
    "[TC-CH-1385-13] on %s, the moved chapter goes on in the camp from its pack, and the chat starts afresh without it",
    async (runtime) => {
      const id = await start(runtime);
      await say(id, "My cat is called Miso.");
      await startChapter(id, "garden", "The garden");
      await say(id, "What should I plant?");
      const moved = await intoNewCamp(id, "garden");
      expect(moved.stub).toMatchObject({ state: "moved", movedTo: GARDEN_CAMP });
      expect(moved.camp).toMatchObject({ kind: "camp", origin: { threadId: id, chapterId: "garden" } });

      // The camp's first turn starts a session from its pack, with the moved chapter's transcript.
      await say(GARDEN_CAMP, "Tomatoes or beans?");
      const inCamp = asked[runtime].at(-1) as PromptRequest;
      expect(inCamp.sessionId).toBeNull();
      expect(inCamp.briefing ?? "").toContain("What should I plant?");
      // Your message from the chat's earlier chapter is not part of it (the reply only echoed its one-line summary).
      expect(inCamp.briefing ?? "").not.toMatch(/^> My cat is called Miso\.$/m);

      // The chat's next turn starts afresh in the chapter that took the moved one's place.
      await say(id, "How is Miso?");
      const inChat = asked[runtime].at(-1) as PromptRequest;
      expect(inChat.sessionId).toBeNull();
      expect(inChat.briefing ?? "").not.toContain("What should I plant?");
      const messages = await run(HobbotsRepository.use((repo) => repo.listMessages(id)));
      expect(messages.map((m) => m.content).filter((text) => text.includes("plant"))).toEqual([]);
    },
  );
});

describe("camp suggestions", () => {
  // covers ADR 037 (Records: CampSuggestion), CH-009
  it("[TC-CH-1385-14] offers a chapter grown past a threshold once, and Keep in chat keeps it from coming back", async () => {
    const id = await start("claude-code");
    await say(id, "Let us plan the launch.");
    const decide = (n: number) =>
      run(Records.use((records) => records.recordYours(id, { key: `d${n}`, text: `Decision ${n}`, replaces: null })));
    for (let n = 1; n <= CAMP_SUGGESTION_DECISIONS; n++) await decide(n);
    const [open] = await run(CampSuggestionService.use((service) => service.listOpen(id)));
    expect(open).toMatchObject({ threadId: id, reasons: [{ code: "decisions", count: CAMP_SUGGESTION_DECISIONS }] });
    const kept = await run(CampSuggestionService.use((service) => service.keep(id, (open as CampSuggestion).id)));
    expect(kept.state).toBe("kept");
    await decide(CAMP_SUGGESTION_DECISIONS + 1);
    expect(await run(CampSuggestionService.use((service) => service.listOpen(id)))).toEqual([]);
    expect(await journaled("CampSuggested")).toHaveLength(1);
  });

  // covers ADR 037 (The hub's brain), STD-ARCH-016
  it("[TC-CH-1385-15] under No AI, a rested chapter is never judged and gets no drift suggestion", async () => {
    const id = await start("claude-code");
    await say(id, "My cat is called Miso.");
    await startChapter(id, "garden", "The garden");
    expect(await run(CampDrift.use((drift) => drift.runOnce))).toBe(true);
    expect(judged).toEqual([]);
    expect(await journaled("CampSuggested")).toEqual([]);
  });

  // covers ADR 037 (The hub's brain), STD-ARCH-016
  it("[TC-CH-1385-16] the hub's brain suggests a drifted chapter once, sure enough, and resumes from its cursor after a restart", async () => {
    const id = await start("claude-code", brain("camp", CAMP_DRIFT_CONFIDENCE));
    await say(id, "My cat is called Miso.");
    await startChapter(id, "garden", "The garden");
    await run(CampDrift.use((drift) => drift.runOnce));
    expect(judged).toHaveLength(1);
    expect(judged[0]).toMatchObject({ task: "judgments", rule: "stay" });
    const [raised] = await journaled("CampSuggested");
    expect((raised as { payload: { suggestion: CampSuggestion } }).payload.suggestion).toMatchObject({
      threadId: id,
      reasons: [{ code: "drift", count: 2 }],
      state: "open",
    });

    // Sent back to the start, it judges again but raises nothing twice: a chapter gets one suggestion.
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE projector_cursors SET sequence = 0 WHERE name = 'camp-drift'`;
      }),
    );
    await run(CampDrift.use((drift) => drift.runOnce));
    expect(await journaled("CampSuggested")).toHaveLength(1);
  });

  // covers ADR 037 (The hub's brain)
  it("[TC-CH-1385-17] a brain that is not sure enough raises nothing", async () => {
    const id = await start("claude-code", brain("camp", CAMP_DRIFT_CONFIDENCE - 0.1));
    await say(id, "My cat is called Miso.");
    await startChapter(id, "garden", "The garden");
    await run(CampDrift.use((drift) => drift.runOnce));
    expect(judged).toHaveLength(1);
    expect(await journaled("CampSuggested")).toEqual([]);
  });
});
