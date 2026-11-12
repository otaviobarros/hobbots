import {
  AdditionalRuntimes,
  ASK_RECORDS,
  askFromRecords,
  ChapterService,
  ChapterSummaries,
  ChatService,
  type Decided,
  FindIndex,
  FindIndexer,
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
  type AskAnswer,
  type Chapter,
  ChapterId,
  DEFAULT_MEMORY_SETTINGS,
  DecisionId,
  FIND_KINDS,
  type FindKind,
  hobActor,
  isInProgress,
  Message,
  MessageId,
  type RuntimeKind,
  roleFields,
  ThreadId,
} from "@hobbots/domain";
import { HubBrainDecider, MemoryModelEndpoint } from "@hobbots/memory";
import {
  ChapterRepositoryLive,
  ChapterSummaryLogLive,
  EventJournal,
  FindIndexLogLive,
  HobbotsRepositoryLive,
  RecordRepositoryLive,
  SearchIndex,
  TaskRepositoryLive,
} from "@hobbots/persistence";
import { TestDatabase } from "@hobbots/persistence/testing";
import { FakeAdditionalRuntimesLayer, FakeRuntimeLayer, makeFakeRuntime } from "@hobbots/runtimes";
import { type Duration, Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventBus } from "../src/event-bus.ts";
import { NodeFolderChecks } from "../src/folders.ts";

// Issue #1386 (ADR 037, Records): find looks through every chat's and camp's decisions, artifacts
// and chapters, kept in the find index by a projector with its own cursor, beside the messages, in
// one chat or camp or everywhere; a private camp is found only from inside it. Ask answers from the
// records that match on the hub's brain and cites each one; under No AI it shows the matches.

const NOW = "2026-11-12T00:00:00.000Z";
const WREN = AgentId.make("wren");

let asked: Record<RuntimeKind, Array<PromptRequest>>;
const recorded = (runtime: RuntimeKind, fake: RuntimeAdapterShape): RuntimeAdapterShape => ({
  ...fake,
  sendPrompt: (request) => {
    asked[runtime].push(request);
    return fake.sendPrompt(request);
  },
});

/** The hub's brain under No AI, on runtimes of its own, so its endpoint counts any model it calls. */
const NoAi = HubBrainDecider(Effect.succeed({ ...DEFAULT_MEMORY_SETTINGS, provider: "none" })).pipe(
  Layer.provideMerge(MemoryModelEndpoint.layer(Redacted.make("k".repeat(64)))),
  Layer.provide(Layer.mergeAll(FakeRuntimeLayer(), FakeAdditionalRuntimesLayer())),
);

/** A brain whose answers the test gives, judgment by judgment; it keeps what it was asked. */
let judged: Array<Judgment<unknown>>;
const scriptedBrain = (answer: (judgment: Judgment<unknown>) => Effect.Effect<Decided<unknown>>) =>
  Layer.succeed(
    HubDecider,
    HubDecider.of({
      decide: <A>(judgment: Judgment<A>) => {
        judged.push(judgment as Judgment<unknown>);
        return answer(judgment as Judgment<unknown>) as Effect.Effect<Decided<A>>;
      },
    }),
  );

/** The number Ask's input gives the record that says `text`. */
const numberOf = (input: string, text: string) =>
  Number(
    input
      .split("\n")
      .find((line) => line.endsWith(text))
      ?.match(/^\[(\d+)\]/)?.[1],
  );

/** The brain's answer to Ask, or to a chapter summary: one line of its own. */
const brainAnswers = (ask: unknown) =>
  scriptedBrain((judgment) =>
    Effect.succeed({
      choice: judgment.task === "chapters" ? "Planned the launch emails." : ask,
      confidence: 0.9,
      by: "brain",
    }),
  );

const hubLayer = <R>(decider: Layer.Layer<R, unknown>) =>
  Layer.mergeAll(
    ChatService.layer.pipe(Layer.provide(HobTools.chatOnly)),
    ChapterService.layer,
    ChapterSummaries.make,
    FindIndexer.make,
  ).pipe(
    Layer.provideMerge(Layer.merge(RecordPackSource.pipe(Layer.provide(Records.layer)), Records.layer)),
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.mergeAll(
          HobbotsRepositoryLive,
          ChapterRepositoryLive,
          ChapterSummaryLogLive.pipe(Layer.provide(EventJournal.layer)),
          FindIndexLogLive.pipe(Layer.provide(EventJournal.layer)),
          TaskRepositoryLive,
          RecordRepositoryLive,
          SearchIndex.layer,
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

type Services = Layer.Success<ReturnType<typeof hubLayer<HubDecider | MemoryModelEndpoint>>>;
let hub: ManagedRuntime.ManagedRuntime<Services, unknown> | undefined;

afterEach(async () => {
  await hub?.dispose();
  hub = undefined;
});

const run = <A, E>(effect: Effect.Effect<A, E, Services>) =>
  (hub as ManagedRuntime.ManagedRuntime<Services, unknown>).runPromise(effect);

/** A hub with Wren, thinking with `runtime`, and her chat. */
const start = async <R extends HubDecider>(runtime: RuntimeKind, decider: Layer.Layer<R, unknown>) => {
  asked = { "claude-code": [], codex: [] };
  judged = [];
  hub = ManagedRuntime.make(hubLayer(decider)) as unknown as ManagedRuntime.ManagedRuntime<Services, unknown>;
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

/** Sends `content` and waits for the turn to end; answers the reply. */
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

/** Wren's reply recorded a decision, as `record_decision` does. */
const decided = (reply: Message, key: string, text: string, replaces: DecisionId | null = null) =>
  run(
    Records.use((records) =>
      records.recordHobs({
        id: DecisionId.make(`decision-${key}`),
        threadId: reply.threadId,
        sourceMessageId: reply.id,
        text,
        replaces,
        actor: hobActor(WREN),
        key,
        input: `${text}\0${replaces}`,
      }),
    ),
  ).then((plan) => plan.recorded);

/** A reply's step wrote `path`, which the artifacts registry keeps. */
const wrote = (reply: Message, path: string) =>
  run(
    HobbotsRepository.use((repo) =>
      repo.upsertMessage(
        new Message({
          ...reply,
          id: MessageId.make(`wrote-${path}`),
          steps: [
            {
              id: "s1",
              kind: "tool",
              label: `Writing ${path}`,
              state: "done",
              call: { tool: "Write", operation: "edit-files", targets: [`/work/${path}`] },
            },
          ],
        }),
      ),
    ),
  );

const index = () => run(FindIndexer.use((indexer) => indexer.runOnce));
const summarize = () => run(ChapterSummaries.use((projector) => projector.runOnce));

const find = (query: string, scope: { in?: ThreadId; kinds?: ReadonlyArray<FindKind> } = {}) =>
  run(FindIndex.use((found) => found.find(query, { in: scope.in ?? null, kinds: scope.kinds ?? FIND_KINDS })));

const ask = (question: string, scope: ThreadId | null = null, timeout: Duration.Input = "5 seconds") =>
  run(askFromRecords(question, { in: scope }, timeout));

/** What a found record says, in a line a test can compare. */
const said = (records: ReadonlyArray<{ _tag: string } & Record<string, unknown>>) =>
  records.map((record) =>
    record._tag === "decision"
      ? `decision: ${record.text} (${record.state})`
      : record._tag === "artifact"
        ? `artifact: ${record.title} v${record.version}`
        : `chapter ${record.number}: ${record.summary}`,
  );

const indexedRows = () =>
  run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return yield* sql<{ kind: string; recordId: string; threadId: string; body: string }>`
        SELECT kind, record_id, thread_id, body FROM find_records ORDER BY kind, record_id`;
    }),
  );

/** A chat with a resting chapter about the launch emails: a decision changed once, and a file. */
const launchChat = async (decider: Layer.Layer<HubDecider, unknown> = brainAnswers(null)) => {
  const id = await start("claude-code", decider);
  const reply = await say(id, "Plan the launch emails.");
  const first = await decided(reply, "a", "Launch emails go out on Wednesdays.");
  await wrote(reply, "launch.md");
  const later = await say(id, "Wednesdays clash with the newsletter.");
  await decided(later, "b", "Launch emails go out on Thursdays.", first.id);
  await startChapter(id, "chapter-2", "Sending");
  await summarize();
  return { id, reply, later };
};

describe("find", () => {
  // covers ADR 037 (Records), STD-ARCH-016, CH-006
  it("[TC-CH-1386-01] finds decisions, artifacts and chapter summaries by their words, by kind and in a chat, with a changed decision crossed out", async () => {
    const { id, reply, later } = await launchChat();
    // Nothing is in the index until the projector reads the journal.
    expect((await find("launch")).records).toEqual([]);
    expect(await index()).toBe(true);

    const found = await find("launch");
    // Newest first: the file was written after the first decision.
    expect(said(found.records)).toEqual([
      "decision: Launch emails go out on Thursdays. (active)",
      "artifact: launch.md v1",
      "decision: Launch emails go out on Wednesdays. (superseded)",
      "chapter 1: Planned the launch emails.",
    ]);
    const [thursday, file, wednesday, chapter] = found.records;
    expect(thursday).toMatchObject({ threadId: id, threadKind: "chat", hobId: WREN, messageId: later.id });
    expect(wednesday).toMatchObject({ messageId: reply.id });
    expect(file).toMatchObject({ kind: "doc", messageId: MessageId.make("wrote-launch.md") });
    // A chapter's citation opens its first message.
    const [prompt] = await run(HobbotsRepository.use((repo) => repo.listMessages(id)));
    expect(chapter).toMatchObject({ number: 1, title: null, messageId: prompt?.id });
    expect(found.messages.map((message) => message.messageId)).toContain(prompt?.id);
    expect(thursday?.snippet.filter((part) => part.match).map((part) => part.text)).toEqual(["Launch"]);

    // By kind, and every word must match.
    expect(said((await find("launch", { kinds: ["decision"] })).records)).toHaveLength(2);
    expect((await find("launch", { kinds: ["decision"] })).messages).toEqual([]);
    expect(said((await find("thursdays launch")).records)).toEqual([
      "decision: Launch emails go out on Thursdays. (active)",
    ]);
    // In another chat, nothing.
    const other = await run(
      ChatService.use((chat) =>
        chat.makeCamp(WREN, { key: ThreadId.make("camp-other"), title: "Other", goal: null, private: false }),
      ),
    );
    expect(await find("launch", { in: other.id })).toEqual({ records: [], messages: [] });
    expect((await find("launch", { in: id })).records).toHaveLength(4);
  });

  // covers ADR 037 (Records), STD-ARCH-016
  it("[TC-CH-1386-02] the projector resumes from its cursor and writes the same rows when the journal is read again", async () => {
    await launchChat();
    expect(await index()).toBe(true);
    const rows = await indexedRows();
    // The live chapter has a title, so it is found by it too.
    expect(rows.map((row) => row.kind)).toEqual(["artifact", "chapter", "chapter", "decision", "decision"]);

    // A projector sent back to the start replays the journal and ends with the same rows.
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE projector_cursors SET sequence = 0 WHERE name = 'find-index'`;
      }),
    );
    expect(await index()).toBe(true);
    expect(await indexedRows()).toEqual(rows);
  });

  // covers ADR 037 (A private camp, Records)
  it("[TC-CH-1386-03] a private camp's records and messages are found only from inside it", async () => {
    const chat = await start("claude-code", brainAnswers(null));
    const camp = await run(
      ChatService.use((service) =>
        service.makeCamp(WREN, { key: ThreadId.make("secret"), title: "Surprise party", goal: null, private: true }),
      ),
    );
    const reply = await say(camp.id, "Plan a surprise party for Ana.");
    await decided(reply, "cake", "The surprise party cake is chocolate.");
    await say(chat, "Remind me about the party.");
    expect(await index()).toBe(true);

    const everywhere = await find("party");
    expect(everywhere.records).toEqual([]);
    expect(new Set(everywhere.messages.map((message) => message.threadId))).toEqual(new Set([chat]));
    const inside = await find("party", { in: camp.id });
    expect(said(inside.records)).toEqual(["decision: The surprise party cake is chocolate. (active)"]);
    expect(new Set(inside.messages.map((message) => message.threadId))).toEqual(new Set([camp.id]));
    expect(await ask("What cake for the party?")).toEqual({ _tag: "Matches", reason: "nothing-found", matches: [] });
    expect(await ask("What cake for the party?", camp.id)).toMatchObject({
      _tag: "Matches",
      matches: [{ _tag: "decision", threadId: camp.id }],
    });
  });

  // covers ADR 037 (Records, Moving a chapter)
  it("[TC-CH-1386-04] a chapter moved into a camp is found in the camp, and no longer in the chat", async () => {
    const { id } = await launchChat();
    expect(await index()).toBe(true);
    const [first] = await run(ChapterService.use((service) => service.listChapters(id)));
    await run(
      ChatService.use((chat) =>
        chat.moveChapter(id, (first as Chapter).id, {
          _tag: "new",
          key: ThreadId.make("camp-launch"),
          title: "Launch",
          goal: null,
          private: false,
        }),
      ),
    );
    expect(await index()).toBe(true);

    expect((await find("launch", { in: id })).records).toEqual([]);
    const inCamp = await find("launch", { in: ThreadId.make("camp-launch") });
    expect(said(inCamp.records).filter((line) => line.startsWith("decision"))).toHaveLength(2);
    expect(inCamp.records.every((record) => record.threadTitle === "Launch")).toBe(true);
  });

  // covers ADR 037 (Records, Moving a chapter, Private camps)
  it("[TC-CH-1386-09] a chapter moved into a private camp is out of Find everywhere at once, before the index catches up", async () => {
    const { id } = await launchChat();
    expect(await index()).toBe(true);
    expect((await find("launch")).records.length).toBeGreaterThan(0);
    const [first] = await run(ChapterService.use((service) => service.listChapters(id)));
    await run(
      ChatService.use((chat) =>
        chat.moveChapter(id, (first as Chapter).id, {
          _tag: "new",
          key: ThreadId.make("camp-secret"),
          title: "Secret launch",
          goal: null,
          private: true,
        }),
      ),
    );

    // The projector has not run since the move, so its rows still name the chat.
    expect((await find("launch")).records).toEqual([]);
    expect((await find("launch", { in: id })).records).toEqual([]);
    expect(await ask("When do the launch emails go out?")).toEqual({
      _tag: "Matches",
      reason: "nothing-found",
      matches: [],
    });
    // Once it catches up, the camp finds them from inside.
    expect(await index()).toBe(true);
    const inCamp = await find("launch", { in: ThreadId.make("camp-secret") });
    expect(said(inCamp.records).filter((line) => line.startsWith("decision"))).toHaveLength(2);
  });
});

describe("ask", () => {
  // covers ADR 037 (Records, The hub's brain)
  it("[TC-CH-1386-05] answers a question about an old decision from the records on the hub's brain, and cites the records it rests on", async () => {
    const { later } = await launchChat(
      scriptedBrain((judgment) =>
        Effect.succeed({
          choice:
            judgment.task === "chapters"
              ? "Planned the launch emails."
              : {
                  answer: "Launch emails go out on Thursdays.",
                  cites: [numberOf(judgment.input, "Launch emails go out on Thursdays.")],
                },
          confidence: 0.9,
          by: "brain",
        }),
      ),
    );
    expect(await index()).toBe(true);

    const answer = await ask("When do the launch emails go out?");
    expect(answer).toMatchObject({ _tag: "Answered", text: "Launch emails go out on Thursdays." });
    const { cites, matches } = answer as Extract<AskAnswer, { _tag: "Answered" }>;
    expect(cites).toHaveLength(1);
    expect(cites[0]).toMatchObject({ _tag: "decision", messageId: later.id, state: "active" });
    expect(matches.length).toBeLessThanOrEqual(ASK_RECORDS);

    // The brain read the question and every match by its number, a crossed-out one marked.
    const judgment = judged.find((asking) => asking.task === "judgments");
    expect(judgment?.input).toContain("Question: When do the launch emails go out?");
    expect(judgment?.input).toMatch(
      /\[\d\] Decision \(crossed out, no longer holds\) in chat "[^"]*", 2026-\d\d-\d\d: Launch emails go out on Wednesdays\./,
    );
  });

  // covers ADR 037 (The hub's brain)
  it("[TC-CH-1386-06] an answer that cites no record it was given, none at all, or none in time leaves the matches alone", async () => {
    let next: () => Effect.Effect<Decided<unknown>> = () =>
      Effect.succeed({ choice: null, confidence: 0.4, by: "brain" });
    await launchChat(
      scriptedBrain((judgment) =>
        judgment.task === "chapters"
          ? Effect.succeed({ choice: "Planned the launch emails.", confidence: 0.9, by: "brain" })
          : next(),
      ),
    );
    expect(await index()).toBe(true);

    // The records do not answer it.
    expect(await ask("When do the launch emails go out?")).toMatchObject({ _tag: "Matches", reason: "no-answer" });
    // The brain gave nothing that decodes.
    next = () => Effect.succeed({ choice: null, confidence: 1, by: "fallback" });
    expect(await ask("When do the launch emails go out?")).toMatchObject({ _tag: "Matches", reason: "no-answer" });
    // A slow brain.
    next = () => Effect.never;
    const slow = await ask("When do the launch emails go out?", null, "200 millis");
    expect(slow).toMatchObject({ _tag: "Matches", reason: "no-answer" });
    expect((slow as Extract<AskAnswer, { _tag: "Matches" }>).matches.length).toBeGreaterThan(0);
    // Words too short to mean anything find nothing, and the brain is not asked.
    const before = judged.length;
    expect(await ask("is it on?")).toEqual({ _tag: "Matches", reason: "nothing-found", matches: [] });
    expect(judged).toHaveLength(before);
  });

  // covers ADR 037 (The hub's brain, Records), RT-001
  it.each<RuntimeKind>(["claude-code", "codex"])(
    "[TC-CH-1386-07] on %s under No AI, a resting chapter gets its plain summary, Ask shows the matches without an answer, and no model is called",
    async (runtime) => {
      const id = await start(runtime, NoAi);
      const reply = await say(id, "Plan the launch emails for spring.");
      await decided(reply, "a", "Launch emails go out on Wednesdays.");
      await startChapter(id, "chapter-2", "Sending");
      expect(await summarize()).toBe(true);
      expect(await index()).toBe(true);

      const [chapter] = await run(ChapterService.use((service) => service.listChapters(id)));
      expect(chapter?.summary).toContain("Plan the launch emails for spring.");
      expect(said((await find("spring", { kinds: ["chapter"] })).records)).toEqual([`chapter 1: ${chapter?.summary}`]);

      const answer = await ask("When do the launch emails go out?");
      expect(answer).toMatchObject({ _tag: "Matches", reason: "no-ai" });
      expect(said((answer as Extract<AskAnswer, { _tag: "Matches" }>).matches)).toContain(
        "decision: Launch emails go out on Wednesdays. (active)",
      );
      expect((await run(MemoryModelEndpoint.use((endpoint) => endpoint.hubUsage))).calls).toBe(0);
      expect(asked[runtime]).toHaveLength(1);
    },
  );
});
