import {
  AdditionalRuntimes,
  ChapterService,
  ChapterSummaries,
  ChatService,
  capturedEntryOf,
  HobAdmission,
  HobbotsRepository,
  HobTools,
  HubDecider,
  makeRedactor,
  PackRecordSource,
  PackReports,
  type PromptRequest,
  RecordPackSource,
  Records,
  RuntimeAdapter,
  type RuntimeAdapterShape,
  TaskRepository,
} from "@hobbots/agents";
import {
  Agent,
  AgentId,
  ChapterId,
  isInProgress,
  Message,
  MessageId,
  QuestionId,
  type RuntimeKind,
  roleFields,
  TaskId,
  type ThreadId,
} from "@hobbots/domain";
import {
  ChapterRepositoryLive,
  ChapterSummaryLogLive,
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

// Issue #1380 (ADR 037): a new chapter's session starts from the context pack, built from records,
// never from the old chapter's transcript. It carries the open work, the active decisions and the
// previous chapter's summary, which a cursor projector writes once, and which a private camp keeps.

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

/** The active decisions of every thread, as #1383 records them; the pack reads them through the port. */
const Decisions = Layer.succeed(
  PackRecordSource,
  PackRecordSource.of({
    activeDecisions: () => Effect.succeed([{ id: "d1", text: "Miso eats only wet food.", recordedAt: NOW }]),
    artifactsIndex: () => Effect.succeed([]),
  }),
);

/** The hub's brain, answering every chapter summary with one line of its own. */
const Brain = Layer.succeed(
  HubDecider,
  HubDecider.of({
    decide: (judgment) =>
      Effect.succeed({ choice: "Talked about Miso the cat." as typeof judgment.rule, confidence: 0.9, by: "brain" }),
  }),
);

/** The pack reading the hub's own Records (#1383), as the hub composes them. */
const StoredRecords = RecordPackSource.pipe(Layer.provide(Records.layer));

const hubLayer = (
  decider: Layer.Layer<never> | Layer.Layer<HubDecider>,
  records: typeof Decisions | typeof StoredRecords = Decisions,
) =>
  Layer.mergeAll(
    ChatService.layer.pipe(Layer.provide(HobTools.chatOnly)),
    ChapterService.layer,
    ChapterSummaries.make,
  ).pipe(
    Layer.provideMerge(Layer.merge(records, Records.layer)),
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.mergeAll(
          HobbotsRepositoryLive,
          ChapterRepositoryLive,
          ChapterSummaryLogLive.pipe(Layer.provide(EventJournal.layer)),
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
const start = async (
  runtime: RuntimeKind,
  decider: Layer.Layer<never> | Layer.Layer<HubDecider> = Layer.empty,
  records: typeof Decisions | typeof StoredRecords = Decisions,
) => {
  asked = { "claude-code": [], codex: [] };
  hub = ManagedRuntime.make(hubLayer(decider, records));
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

/** A Task you asked for in the chat, with a step that ran and a question that waits for an answer. */
const openTask = (threadId: ThreadId) =>
  run(
    Effect.gen(function* () {
      const tasks = yield* TaskRepository;
      const task = (id: string, brief: string, parentId: string | null) => ({
        id: TaskId.make(id),
        ownerId: WREN,
        parentId: parentId === null ? null : TaskId.make(parentId),
        threadId,
        brief,
        dependsOn: [],
        createdAt: NOW,
      });
      yield* tasks.createTask({ task: task("vet", "Book Miso's vet visit", null), delegation: null, milestones: [] });
      yield* tasks.createTask({
        task: task("vet-call", "Call the vet for a slot", "vet"),
        delegation: null,
        milestones: [],
      });
      yield* tasks.askQuestion({
        id: QuestionId.make("q-day"),
        taskId: TaskId.make("vet-call"),
        askerId: WREN,
        text: "Tuesday or Thursday?",
        createdAt: NOW,
      });
    }),
  );

const summarizedEntries = () =>
  run(
    EventJournal.use((journal) => journal.readAfter(0, 10_000)).pipe(
      Effect.map((entries) => entries.filter((entry) => entry.payload._tag === "ChapterSummarized")),
    ),
  );

describe("the context pack", () => {
  // covers ADR 037 (The context pack), CH-001, RT-001
  it.each<RuntimeKind>(["claude-code", "codex"])(
    "[TC-CH-1380-10] on %s, a new chapter's first session gets the open Task, its question, the decisions and the last chapter's summary from the pack alone",
    async (runtime) => {
      const id = await start(runtime);
      await say(id, "My cat is called Miso.");
      await openTask(id);
      await say(id, "She is three, and the vet wants to see her.");
      await startChapter(id, "chapter-2", "The garden");

      // The projector has not run: the pack builds the plain summary in its place.
      await say(id, "What should I plant?");
      const fresh = asked[runtime].at(-1) as PromptRequest;
      expect(fresh.sessionId).toBeNull();
      const told = fresh.briefing ?? "";
      expect(told).toContain("- Open Task: Book Miso's vet visit (Task vet, ");
      expect(told).toContain("last step: Call the vet for a slot (");
      expect(told).toContain("- A question waiting for an answer: Tuesday or Thursday? (question q-day)");
      expect(told).toContain("- Miso eats only wet food. (decision d1)");
      expect(told).toContain("- Chapter 1: 4 messages, starting with “My cat is called Miso.”");
      // Nothing of the old transcript.
      expect(told).not.toContain("> My cat is called Miso.");
      expect(told).not.toContain("She is three");
      expect(told).not.toContain("## This chapter so far");

      // The turn's report is kept, and the dev-only endpoint's read shows the next pack.
      const pack = await run(ChatService.use((chat) => chat.contextPack(id)));
      expect(pack.lastTurn?.parts.map((part) => part.part)).toContain("chapters");
      expect(pack.lastTurn?.tokens).toBeGreaterThan(0);
      expect(pack.next.text).toContain("## This chapter so far");
      expect(pack.next.report.tokens).toBeLessThanOrEqual(pack.next.report.budget);
    },
  );

  // covers ADR 037 (The context pack, Records), CH-001
  it.each<RuntimeKind>(["claude-code", "codex"])(
    "[TC-CH-1383-11] on %s, a new chapter's first session gets the decisions that hold and what the thread made, and no crossed-out decision",
    async (runtime) => {
      const id = await start(runtime, Layer.empty, StoredRecords);
      const reply = await say(id, "Plan the launch emails.");
      await run(
        Effect.gen(function* () {
          const records = yield* Records;
          const first = yield* records.recordYours(id, {
            key: "a",
            text: "Emails go out on Tuesdays.",
            replaces: null,
          });
          yield* records.recordYours(id, {
            key: "b",
            text: "Emails go out on Wednesdays.",
            replaces: first.recorded.id,
          });
          yield* records.recordYours(id, { key: "c", text: "Miso eats only wet food.", replaces: null });
          // A reply's step wrote the launch plan, which the registry keeps.
          yield* (yield* HobbotsRepository).upsertMessage(
            new Message({
              ...reply,
              id: MessageId.make("wrote-plan"),
              steps: [
                {
                  id: "s1",
                  kind: "tool",
                  label: "Writing launch.md",
                  state: "done",
                  call: { tool: "Write", operation: "edit-files", targets: ["/work/launch.md"] },
                },
              ],
            }),
          );
        }).pipe(asOwner),
      );
      await startChapter(id, "chapter-2", "Sending");

      await say(id, "When do the emails go out?");
      const told = (asked[runtime].at(-1) as PromptRequest).briefing ?? "";
      expect(told).toContain("## Active decisions");
      expect(told).toMatch(/- Miso eats only wet food\. \(decision [^)]+\)\n- Emails go out on Wednesdays\./);
      expect(told).not.toContain("Tuesdays");
      expect(told).toContain("## What this thread made");
      expect(told).toContain("- doc: launch.md (version 1)");
    },
  );

  // covers ADR 037 (The context pack), STD-ARCH-016
  it("[TC-CH-1380-11] the summary projector writes each resting chapter's summary once, and resumes from its cursor after a restart", async () => {
    const id = await start("claude-code", Brain);
    await say(id, "My cat is called Miso.");
    await startChapter(id, "chapter-2", "The garden");

    expect(await run(ChapterSummaries.use((projector) => projector.runOnce))).toBe(true);
    expect(await summarizedEntries()).toHaveLength(1);
    const chapters = await run(ChapterService.use((service) => service.listChapters(id)));
    expect(chapters.map((c) => [c.number, c.state, c.summary])).toEqual([
      [1, "resting", "Talked about Miso the cat."],
      [2, "live", null],
    ]);

    // A restarted projector resumes from its cursor; one sent back to the start replays the
    // journal and writes nothing twice.
    await run(ChapterSummaries.use((projector) => projector.runOnce));
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE projector_cursors SET sequence = 0`;
      }),
    );
    await run(ChapterSummaries.use((projector) => projector.runOnce));
    expect(await summarizedEntries()).toHaveLength(1);

    // The next new session reads the projector's summary.
    await say(id, "What should I plant?");
    expect(asked["claude-code"].at(-1)?.briefing).toContain("- Chapter 1: Talked about Miso the cat.");
  });

  // covers ADR 037 (The context pack), STD-ARCH-014, STD-ARCH-016
  it("[TC-CH-1380-13] a summary the brain wrote while a split changed its chapter is never kept: the chapter is summarized again from what it now holds", async () => {
    // The brain's first answer waits until the split has landed, and says it is stale.
    let reached = () => {};
    const atBrain = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const slowBrain = Layer.succeed(
      HubDecider,
      HubDecider.of({
        decide: (judgment) =>
          Effect.gen(function* () {
            calls += 1;
            if (calls === 1) {
              reached();
              yield* Effect.promise(() => gate);
              return { choice: "Stale summary." as typeof judgment.rule, confidence: 0.9, by: "brain" as const };
            }
            return { choice: "Fresh summary." as typeof judgment.rule, confidence: 0.9, by: "brain" as const };
          }),
      }),
    );
    const id = await start("claude-code", slowBrain);
    await say(id, "My cat is called Miso.");
    await say(id, "Now the garden.");
    await startChapter(id, "chapter-2", "Plans");

    const round = run(ChapterSummaries.use((projector) => projector.runOnce));
    await atBrain;
    const prompt = (await run(HobbotsRepository.use((repo) => repo.listMessages(id)))).find(
      (m) => m.role === "user" && m.content === "Now the garden.",
    ) as Message;
    await run(
      ChapterService.use((chapters) =>
        chapters.splitChapter(id, { id: ChapterId.make("garden"), messageId: prompt.id, title: "The garden" }),
      ),
    );
    release();
    expect(await round).toBe(true);
    // The stale summary was not kept; the split's own journal entry brings both chapters to the next round.
    expect((await run(ChapterService.use((service) => service.listChapters(id)))).map((c) => c.summary)).toEqual([
      null,
      null,
      null,
    ]);
    await run(ChapterSummaries.use((projector) => projector.runOnce));

    const chapters = await run(ChapterService.use((service) => service.listChapters(id)));
    expect(chapters.map((c) => [c.number, c.state, c.summary])).toEqual([
      [1, "resting", "Fresh summary."],
      [2, "resting", "Fresh summary."],
      [3, "live", null],
    ]);
    expect(await summarizedEntries()).toHaveLength(2);
  });

  // covers ADR 037 (The context pack), ADR 028
  it("[TC-CH-1380-12] a private camp's chapter summary stays in that camp: memory capture takes nothing of it, and another camp's pack never reads it", async () => {
    const chat = await start("claude-code");
    const camp = await run(
      ChatService.use((service) =>
        service.makeCamp(WREN, { key: "secret" as ThreadId, title: "Surprise party", goal: null, private: true }),
      ),
    );
    await say(camp.id, "Plan a surprise party for Ana.");
    await startChapter(camp.id, "camp-2", "The cake");
    await run(ChapterSummaries.use((projector) => projector.runOnce));

    const [summarized] = await summarizedEntries();
    expect(summarized?.payload).toMatchObject({ _tag: "ChapterSummarized", threadId: camp.id });
    // Memory capture reads nothing from a summary, in a private camp or any other.
    expect(capturedEntryOf(summarized as NonNullable<typeof summarized>, makeRedactor())).toBeNull();

    // The camp's own next session hears it; the chat's pack never does.
    await say(camp.id, "Chocolate?");
    expect(asked["claude-code"].at(-1)?.briefing).toContain("Plan a surprise party for Ana.");
    await say(chat, "Hello");
    const elsewhere = await run(ChatService.use((service) => service.contextPack(chat)));
    expect(elsewhere.next.text ?? "").not.toContain("surprise");
    expect(asked["claude-code"].at(-1)?.briefing ?? "").not.toContain("surprise");
  });
});
