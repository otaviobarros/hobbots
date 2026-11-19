import {
  AdditionalRuntimes,
  CampDrift,
  CampSuggestionService,
  ChapterBreaks,
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
  CHAPTER_BREAK_IDLE_MINUTES,
  ChannelId,
  ChapterId,
  isInProgress,
  Message,
  MessageId,
  OWNER_ACTOR,
  type RuntimeKind,
  roleFields,
} from "@hobbots/domain";
import {
  CampSuggestionRepositoryLive,
  ChapterBreakRepositoryLive,
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
import { asOwner } from "./window-device.ts";

// Issue #1385 (ADR 037): a chapter moved into a camp goes on there, on every runtime: the camp's next
// turn starts a session from its pack, which carries the moved chapter's transcript, and the chat's
// starts afresh without it. A chat chapter grown past a threshold is suggested once, and Keep in chat
// keeps it from coming back. Once a chat chapter rests, the hub's brain may suggest it as a camp;
// under No AI no model is asked and the rule stands.
//
// Issue #1557: a suggestion is offered only once the hub checked its chapter holds one topic, with the
// camp's name and goal the brain suggests, or under No AI the chapter's own title and no goal. A
// chapter that holds several topics is never offered whole. A person's message that opens a new
// topic starts the chat's next chapter, by the brain's judgment or, under No AI, after an idle gap.

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

/** What the brain answers a judgment, by what it is asked: drift, a suggested chapter's naming, or a break. */
interface Answers {
  readonly drift?: readonly [string, number];
  /** The answers, in turn, the last one again once they run out. */
  readonly naming?: ReadonlyArray<unknown>;
  readonly break?: ReadonlyArray<unknown>;
}

/** Which judgment a question is, by the words it opens with. */
const kindOf = (judgment: Judgment<unknown>): keyof Answers =>
  judgment.question.startsWith("This chapter of a chat just ended")
    ? "drift"
    : judgment.question.startsWith("The hub may suggest")
      ? "naming"
      : "break";

/**
 * The hub's brain, answering each judgment as `answers` say, sure at `confidence` unless they say,
 * and with the rule's answer for one they do not name, remembering what it was asked.
 */
const brain = (answers: Answers) =>
  Layer.succeed(
    HubDecider,
    HubDecider.of({
      decide: (judgment) => {
        judged.push(judgment as Judgment<unknown>);
        const kind = kindOf(judgment as Judgment<unknown>);
        if (kind === "drift" && answers.drift !== undefined) {
          const [choice, confidence] = answers.drift;
          return Effect.succeed({ choice: choice as typeof judgment.rule, confidence, by: "brain" });
        }
        const given = answers[kind as "naming" | "break"];
        const answer =
          given === undefined ? undefined : given.length > 1 ? (given as Array<unknown>).shift() : given[0];
        return Effect.succeed(
          answer === undefined
            ? { choice: judgment.rule, confidence: 1, by: "fallback" }
            : { choice: answer as typeof judgment.rule, confidence: 0.9, by: "brain" },
        );
      },
    }),
  );

const hubLayer = (decider: Layer.Layer<never> | Layer.Layer<HubDecider>) =>
  Layer.mergeAll(CampDrift.make, ChapterBreaks.make).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        ChatService.layer.pipe(Layer.provide(HobTools.chatOnly)),
        ChapterService.layer,
        CampSuggestionService.layer,
      ),
    ),
    Layer.provideMerge(Layer.merge(RecordPackSource.pipe(Layer.provide(Records.layer)), Records.layer)),
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.mergeAll(
          HobbotsRepositoryLive,
          ChapterRepositoryLive,
          CampSuggestionRepositoryLive.pipe(Layer.provide(EventJournal.layer)),
          ChapterBreakRepositoryLive.pipe(Layer.provide(EventJournal.layer)),
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
      return (yield* (yield* ChatService).createChannel(WREN)).id;
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

const startChapter = (id: ChannelId, chapter: string, title: string) =>
  run(ChapterService.use((chapters) => chapters.startChapter(id, { id: ChapterId.make(chapter), title })));

const GARDEN_CAMP = ChannelId.make("camp-garden");

const intoNewCamp = (id: ChannelId, chapter: string) =>
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

const runDrift = () => run(CampDrift.use((drift) => drift.runOnce));
const runBreaks = () => run(ChapterBreaks.use((breaks) => breaks.runOnce));
const chaptersOf = (id: ChannelId) => run(ChapterService.use((chapters) => chapters.listChapters(id)));
const openIn = (id: ChannelId) => run(CampSuggestionService.use((service) => service.listOpen(id)));

/** Moves every message of the channel written so far back by `minutes`, as if the chat sat idle since. */
const idleFor = (id: ChannelId, minutes: number) =>
  run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ readonly id: string; readonly createdAt: string }>`SELECT id, created_at FROM messages
        WHERE channel_id = ${id}`;
      for (const row of rows) {
        const earlier = new Date(Date.parse(row.createdAt) - minutes * 60_000).toISOString();
        yield* sql`UPDATE messages SET created_at = ${earlier} WHERE id = ${row.id}`;
      }
    }),
  );

/** Records `count` of your decisions in the channel, keyed from `from`. */
const decideMany = async (id: ChannelId, count: number, from = 1) => {
  for (let n = from; n < from + count; n++) {
    await run(
      asOwner(
        Records.use((records) => records.recordYours(id, { key: `d${n}`, text: `Decision ${n}`, replaces: null })),
      ),
    );
  }
};

const journaled = (type: string) =>
  run(
    EventJournal.use((journal) => journal.readAfter(0, 10_000)).pipe(
      Effect.map((entries) => entries.filter((entry) => entry.payload._tag === type)),
    ),
  );

describe("a chapter moved into a camp", () => {
  // covers ADR 037 (Moving a chapter into a camp moves it), CH-009, RT-001
  it.each<RuntimeKind>(["claude-code", "codex"])(
    "on %s, the moved chapter goes on in the camp from its pack, and the chat starts afresh without it (#1385)",
    async (runtime) => {
      const id = await start(runtime);
      await say(id, "My cat is called Miso.");
      await startChapter(id, "garden", "The garden");
      await say(id, "What should I plant?");
      const moved = await intoNewCamp(id, "garden");
      expect(moved.stub).toMatchObject({ state: "moved", movedTo: GARDEN_CAMP });
      expect(moved.camp).toMatchObject({ kind: "camp", origin: { channelId: id, chapterId: "garden" } });

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

describe("a resting chapter moved into a camp", () => {
  // covers ADR 037 (Moving a chapter into a camp moves it), CH-009, RT-001
  it.each<RuntimeKind>(["claude-code", "codex"])(
    "on %s, the chat's live chapter, which had a session, starts afresh once an earlier chapter moves out (#1385)",
    async (runtime) => {
      const id = await start(runtime);
      await say(id, "What should I plant?");
      await run(
        asOwner(
          Records.use((records) => records.recordYours(id, { key: "beds", text: "Raised beds", replaces: null })),
        ),
      );
      const [first] = await run(ChapterService.use((chapters) => chapters.listChapters(id)));
      await startChapter(id, "miso", "Miso");
      await say(id, "My cat is called Miso.");
      await say(id, "She likes boxes.");
      // The live chapter's session is resumed while nothing moves.
      expect((asked[runtime].at(-1) as PromptRequest).sessionId).not.toBeNull();

      await intoNewCamp(id, (first as { id: string }).id);
      await say(id, "How is Miso?");
      const inChat = asked[runtime].at(-1) as PromptRequest;
      expect(inChat.sessionId).toBeNull();
      // The moved chapter's decision and summary are gone from the pack (the old reply only echoed them).
      expect(inChat.briefing ?? "").not.toMatch(/^- Raised beds/m);
      expect(inChat.briefing ?? "").not.toMatch(/^## Earlier chapters$/m);
      expect(inChat.briefing ?? "").toContain("She likes boxes.");
    },
  );
});

describe("camp suggestions", () => {
  // covers ADR 037 (Records: CampSuggestion), CH-009
  it("offers a chapter grown past a threshold once, and Keep in chat keeps it from coming back (#1385)", async () => {
    const id = await start("claude-code");
    await say(id, "Let us plan the launch.");
    const decide = (n: number) =>
      run(
        asOwner(
          Records.use((records) => records.recordYours(id, { key: `d${n}`, text: `Decision ${n}`, replaces: null })),
        ),
      );
    for (let n = 1; n <= CAMP_SUGGESTION_DECISIONS; n++) await decide(n);
    // Raised pending: it is offered once the hub checked its chapter and named the camp.
    expect(await run(CampSuggestionService.use((service) => service.listOpen(id)))).toEqual([]);
    await runDrift();
    const [open] = await run(CampSuggestionService.use((service) => service.listOpen(id)));
    // Under No AI no model is asked: the camp takes the chapter's own title, none here, and no goal.
    expect(judged).toEqual([]);
    expect(open).toMatchObject({
      channelId: id,
      reasons: [{ code: "decisions", count: CAMP_SUGGESTION_DECISIONS }],
      title: null,
      goal: null,
    });
    const kept = await run(CampSuggestionService.use((service) => service.keep(id, (open as CampSuggestion).id)));
    expect(kept.state).toBe("kept");
    await decide(CAMP_SUGGESTION_DECISIONS + 1);
    expect(await run(CampSuggestionService.use((service) => service.listOpen(id)))).toEqual([]);
    expect(await journaled("CampSuggested")).toHaveLength(1);
  });

  // covers ADR 037 (The hub's brain), STD-ARCH-016
  it("under No AI, a rested chapter is never judged and gets no drift suggestion (#1385)", async () => {
    const id = await start("claude-code");
    await say(id, "My cat is called Miso.");
    await startChapter(id, "garden", "The garden");
    expect(await run(CampDrift.use((drift) => drift.runOnce))).toBe(true);
    expect(judged).toEqual([]);
    expect(await journaled("CampSuggested")).toEqual([]);
  });

  // covers ADR 037 (The hub's brain), STD-ARCH-016
  it("the hub's brain suggests a drifted chapter once, sure enough, and resumes from its cursor after a restart (#1385)", async () => {
    const id = await start("claude-code", brain({ drift: ["camp", CAMP_DRIFT_CONFIDENCE] }));
    await say(id, "My cat is called Miso.");
    await startChapter(id, "garden", "The garden");
    await runDrift();
    expect(judged.map((judgment) => kindOf(judgment))).toEqual(["drift"]);
    expect(judged[0]).toMatchObject({ task: "judgments", rule: "stay" });
    const [raised] = await journaled("CampSuggested");
    expect((raised as { payload: { suggestion: CampSuggestion } }).payload.suggestion).toMatchObject({
      channelId: id,
      reasons: [{ code: "drift", count: 2 }],
      state: "pending",
    });
    // The next round reads the suggestion it raised, and names it: the brain gives no answer here,
    // so the camp takes the chapter's own title, none for a chat's first, never "Chapter 1".
    await runDrift();
    expect(judged.map((judgment) => kindOf(judgment))).toEqual(["drift", "naming"]);
    expect(await openIn(id)).toMatchObject([{ title: null, goal: null }]);

    // Sent back to the start, it judges again but raises nothing twice: a chapter gets one suggestion.
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE projector_cursors SET sequence = 0 WHERE name = 'camp-drift'`;
      }),
    );
    await runDrift();
    expect(await journaled("CampSuggested")).toHaveLength(1);
    expect(await journaled("CampSuggestionOffered")).toHaveLength(1);
  });

  // covers ADR 037 (The hub's brain)
  it("a brain that is not sure enough raises nothing (#1385)", async () => {
    const id = await start("claude-code", brain({ drift: ["camp", CAMP_DRIFT_CONFIDENCE - 0.1] }));
    await say(id, "My cat is called Miso.");
    await startChapter(id, "garden", "The garden");
    await runDrift();
    expect(judged).toHaveLength(1);
    expect(await journaled("CampSuggested")).toEqual([]);
  });
});

describe("a suggested camp's name and goal", () => {
  // covers ADR 037 (The hub's brain), #1557
  it("the hub's brain names the camp and its goal from the chapter's topic (#1557)", async () => {
    const id = await start(
      "claude-code",
      brain({ naming: [{ topics: "one", title: "  Launch plan\n", goal: "Ship the launch by Friday." }] }),
    );
    await say(id, "Let us plan the launch.");
    await decideMany(id, CAMP_SUGGESTION_DECISIONS);
    await runDrift();
    expect(judged.map((judgment) => kindOf(judgment))).toEqual(["naming"]);
    const [naming] = judged;
    expect(naming?.input).toContain("[1] ");
    expect(naming?.input).toContain("Let us plan the launch.");
    const [open] = await openIn(id);
    expect(open).toMatchObject({ state: "open", title: "Launch plan", goal: "Ship the launch by Friday." });
    const [offered] = await journaled("CampSuggestionOffered");
    expect((offered as { payload: { suggestion: CampSuggestion } }).payload.suggestion).toMatchObject({
      id: open?.id,
      title: "Launch plan",
    });
  });

  // covers ADR 037 (The hub's brain), #1557
  it("names a suggestion once from its chapter as it is after a chapter change, and offers it (#1557)", async () => {
    const id = await start("claude-code", brain({ naming: [{ topics: "one", title: "Launch plan", goal: "" }] }));
    await say(id, "Let us plan the launch.");
    await decideMany(id, CAMP_SUGGESTION_DECISIONS);
    // The chapter ends before the hub names its suggestion, so the page holds both.
    await startChapter(id, "next", "Next");
    await runDrift();
    expect(judged.filter((judgment) => kindOf(judgment) === "naming")).toHaveLength(1);
    expect(await openIn(id)).toMatchObject([{ state: "open", title: "Launch plan" }]);
  });

  // covers ADR 037 (The hub's brain), #1557
  it("a suggestion raised before its chapter has a line to judge is named once a message arrives (#1557)", async () => {
    const id = await start("claude-code", brain({ naming: [{ topics: "one", title: "Launch plan", goal: "" }] }));
    await decideMany(id, CAMP_SUGGESTION_DECISIONS);
    await runDrift();
    expect(await openIn(id)).toEqual([]);
    await say(id, "Let us plan the launch.");
    await runDrift();
    expect(await openIn(id)).toMatchObject([{ state: "open", title: "Launch plan" }]);
  });

  // covers ADR 037 (The hub's brain), #1557
  it("under No AI, and on a fallback, the camp takes the chapter's own title and no goal (#1557)", async () => {
    for (const decider of [Layer.empty, brain({})]) {
      const id = await start("claude-code", decider);
      await say(id, "My cat is called Miso.");
      await startChapter(id, "garden", "The garden");
      await say(id, "What should I plant?");
      await decideMany(id, CAMP_SUGGESTION_DECISIONS);
      await runDrift();
      expect(await openIn(id)).toMatchObject([{ chapterId: "garden", title: "The garden", goal: null }]);
      await hub?.dispose();
    }
  });
});

describe("a chapter that holds several topics", () => {
  // covers ADR 037 (Records: CampSuggestion), ADR 039 (Chapters run on their own), #1557
  it.each<RuntimeKind>(["claude-code", "codex"])(
    "on %s, under No AI, is never offered whole: its last topic, after an idle gap, splits off and starts afresh (#1557)",
    async (runtime) => {
      const id = await start(runtime);
      await say(id, "My cat is called Miso.");
      // The whole history sits in one chapter, as the chapters migration left it, with a break in it.
      await idleFor(id, CHAPTER_BREAK_IDLE_MINUTES + 5);
      await say(id, "Back to the garden plans.");
      await decideMany(id, CAMP_SUGGESTION_DECISIONS);
      await runDrift();

      expect(await openIn(id)).toEqual([]);
      const [expired] = await journaled("CampSuggestionExpired");
      expect((expired as { payload: { suggestion: CampSuggestion } }).payload.suggestion.state).toBe("expired");
      const chapters = await chaptersOf(id);
      expect(chapters.map((chapter) => [chapter.number, chapter.title, chapter.state])).toEqual([
        [1, null, "resting"],
        [2, "Back to the garden plans.", "live"],
      ]);
      const messages = await run(HobbotsRepository.use((repo) => repo.listMessages(id)));
      expect(messages.filter((m) => m.chapterId === chapters[1]?.id).map((m) => m.content)).toEqual([
        "Back to the garden plans.",
        "Echo: Back to the garden plans.",
      ]);

      // The topic that split off goes on in a fresh session from the pack.
      await say(id, "Tomatoes or beans?");
      expect((asked[runtime].at(-1) as PromptRequest).sessionId).toBeNull();
    },
  );

  // covers ADR 037 (The hub's brain), #1557
  it("with the brain, splits where it says the last topic starts, and raises that part on its own counts (#1557)", async () => {
    const id = await start(
      "claude-code",
      brain({
        naming: [
          { topics: "several", from: 3, title: "Garden" },
          { topics: "one", title: "Garden", goal: "" },
        ],
      }),
    );
    await say(id, "My cat is called Miso.");
    await say(id, "Now, the garden.");
    await decideMany(id, CAMP_SUGGESTION_DECISIONS);
    await runDrift();
    const chapters = await chaptersOf(id);
    expect(chapters.map((chapter) => chapter.title)).toEqual([null, "Garden"]);
    // Your decisions stayed in the first part, so the part that split off reaches no threshold.
    expect(await openIn(id)).toEqual([]);
    expect(await journaled("CampSuggested")).toHaveLength(1);

    // It grows past one on its own, and is offered then.
    await decideMany(id, CAMP_SUGGESTION_DECISIONS, 10);
    await runDrift();
    expect(await openIn(id)).toMatchObject([{ chapterId: chapters[1]?.id }]);
  });

  // covers ADR 037 (The hub's brain), #1557
  it("is withdrawn when the brain names no line its last topic could start at (#1557)", async () => {
    const id = await start("claude-code", brain({ naming: [{ topics: "several", from: 1, title: "Garden" }] }));
    await say(id, "My cat is called Miso.");
    await decideMany(id, CAMP_SUGGESTION_DECISIONS);
    await runDrift();
    expect(await openIn(id)).toEqual([]);
    expect(await chaptersOf(id)).toHaveLength(1);
    expect(await journaled("CampSuggestionExpired")).toHaveLength(1);
  });
});

describe("chapters that start on their own", () => {
  // covers ADR 039 (Chapters run on their own), RT-001, #1557
  it.each<RuntimeKind>(["claude-code", "codex"])(
    "on %s, under No AI, a message after an idle gap starts the next chapter, and the turn after it a fresh session (#1557)",
    async (runtime) => {
      const id = await start(runtime);
      await say(id, "My cat is called Miso.");
      await say(id, "She likes boxes.");
      // Talk that carries on with no gap stays in the chapter.
      await runBreaks();
      expect(await chaptersOf(id)).toHaveLength(1);
      expect((asked[runtime].at(-1) as PromptRequest).sessionId).not.toBeNull();

      await idleFor(id, CHAPTER_BREAK_IDLE_MINUTES);
      await say(id, "Let us plan the garden.");
      await runBreaks();
      expect(judged).toEqual([]);
      const chapters = await chaptersOf(id);
      expect(chapters.map((chapter) => [chapter.number, chapter.title, chapter.state])).toEqual([
        [1, null, "resting"],
        [2, "Let us plan the garden.", "live"],
      ]);
      await say(id, "Tomatoes or beans?");
      const next = asked[runtime].at(-1) as PromptRequest;
      expect(next.sessionId).toBeNull();
      expect(next.briefing ?? "").toContain("Let us plan the garden.");

      // Read again after a restart, it starts nothing twice.
      await run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`UPDATE projector_cursors SET sequence = 0 WHERE name = 'chapter-breaks'`;
        }),
      );
      await runBreaks();
      expect(await chaptersOf(id)).toHaveLength(2);
    },
  );

  // covers ADR 039 (Chapters run on their own, Reply threads), #1484
  it("a reply in a thread starts no chapter, so the brain never judges one, even after an idle gap (#1484)", async () => {
    const id = await start("claude-code", brain({ break: [{ topic: "new", title: "The garden" }] }));
    const asked = await say(id, "My cat is called Miso.");
    await idleFor(id, CHAPTER_BREAK_IDLE_MINUTES);
    const [root] = (await run(HobbotsRepository.use((repo) => repo.listMessages(id)))).filter(
      (message) => message.role === "user",
    );
    await run(
      HobbotsRepository.use((repo) =>
        repo.sendMessage(
          new Message({
            id: MessageId.make("aside"),
            channelId: id,
            actor: OWNER_ACTOR,
            role: "user",
            content: "Let us plan the garden.",
            status: "complete",
            error: null,
            configVersion: null,
            rootMessageId: root?.id ?? asked.id,
            createdAt: new Date().toISOString(),
          }),
          { mentions: [], repliesTo: null },
        ),
      ),
    );
    await runBreaks();
    expect(judged).toEqual([]);
    expect(await chaptersOf(id)).toHaveLength(1);
  });

  // covers ADR 039 (Chapters run on their own), #1557
  it("the hub's brain starts one where a message opens a new topic, titled by it, and never at a chapter's start (#1557)", async () => {
    const id = await start("claude-code", brain({ break: [{ topic: "new", title: "The garden" }] }));
    await say(id, "My cat is called Miso.");
    await runBreaks();
    // A chat's first message starts its first chapter already, so it is never judged.
    expect(judged).toEqual([]);
    await say(id, "Let us plan the garden.");
    await runBreaks();
    expect(judged.map((judgment) => kindOf(judgment))).toEqual(["break"]);
    expect(judged[0]?.input).toContain("The new message:");
    expect(judged[0]?.rule).toEqual({ topic: "same", title: "" });
    expect((await chaptersOf(id)).map((chapter) => chapter.title)).toEqual([null, "The garden"]);
  });

  // covers ADR 039 (Chapters run on their own), #1557
  it("a brain that hears the same topic, or is not sure enough, starts none, even after a gap (#1557)", async () => {
    const id = await start("claude-code", brain({ break: [{ topic: "same", title: "" }] }));
    await say(id, "My cat is called Miso.");
    await idleFor(id, CHAPTER_BREAK_IDLE_MINUTES * 2);
    await say(id, "How is Miso today?");
    await runBreaks();
    expect(judged).toHaveLength(1);
    expect(judged[0]?.rule).toMatchObject({ topic: "new" });
    expect(await chaptersOf(id)).toHaveLength(1);
  });
});
