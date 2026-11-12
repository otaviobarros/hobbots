import {
  AdditionalRuntimes,
  BriefLog,
  CampBriefs,
  ChapterService,
  ChatService,
  capturedEntryOf,
  type Decided,
  HobAdmission,
  HobbotsRepository,
  HobTools,
  HubDecider,
  makeRedactor,
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
  CheckpointId,
  DEFAULT_MEMORY_SETTINGS,
  isInProgress,
  Message,
  MessageId,
  MilestoneId,
  QuestId,
  type RuntimeKind,
  roleFields,
  TaskId,
  type ThreadId,
} from "@hobbots/domain";
import { HubBrainDecider, MemoryModelEndpoint } from "@hobbots/memory";
import {
  BriefLogLive,
  ChapterRepositoryLive,
  EventJournal,
  HobbotsRepositoryLive,
  RecordRepositoryLive,
  TaskRepositoryLive,
} from "@hobbots/persistence";
import { TestDatabase } from "@hobbots/persistence/testing";
import { FakeAdditionalRuntimesLayer, FakeRuntimeLayer, makeFakeRuntime } from "@hobbots/runtimes";
import { Effect, Layer, ManagedRuntime, Option, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventBus } from "../src/event-bus.ts";
import { NodeFolderChecks } from "../src/folders.ts";

// Issue #1384 (ADR 037, Records, The hub's brain): each chat's and camp's brief is written by a hub
// projector at chapter ends and Quest steps, never by a hob turn. Under No AI it is the plain brief
// from decisions and artifacts and no model is called; a restart resumes from the cursor and writes
// nothing twice; a failed or slow brain leaves the last brief in place and never holds up a turn.
// A new chapter's session reads it from the context pack, on every runtime.

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

/** A brain whose answers the test sets, one judgment at a time. */
const scriptedBrain = (answer: () => Effect.Effect<Decided<string>>) =>
  Layer.succeed(HubDecider, HubDecider.of({ decide: <A>() => answer() as unknown as Effect.Effect<Decided<A>> }));

const brain = (choice: string): Decided<string> => ({ choice, confidence: 0.9, by: "brain" });

/** How long the brain has for one brief in these tests, so a slow one shows quickly. */
const TIMEOUT = "300 millis";

const hubLayer = <R>(decider: Layer.Layer<R, unknown>) =>
  Layer.mergeAll(
    ChatService.layer.pipe(Layer.provide(HobTools.chatOnly)),
    ChapterService.layer,
    CampBriefs.makeWith({ judgmentTimeout: TIMEOUT }),
  ).pipe(
    Layer.provideMerge(Layer.merge(RecordPackSource.pipe(Layer.provide(Records.layer)), Records.layer)),
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.mergeAll(
          HobbotsRepositoryLive,
          ChapterRepositoryLive,
          BriefLogLive.pipe(Layer.provide(EventJournal.layer)),
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

const decide = (id: ThreadId, key: string, text: string) =>
  run(Records.use((records) => records.recordYours(id, { key, text, replaces: null })));

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

const projectOnce = () => run(CampBriefs.use((projector) => projector.runOnce));
const briefOf = (id: ThreadId) => run(BriefLog.use((log) => log.briefOf(id))).then(Option.getOrNull);
const briefEntries = () =>
  run(
    EventJournal.use((journal) => journal.readAfter(0, 10_000)).pipe(
      Effect.map((entries) => entries.filter((entry) => entry.payload._tag === "BriefWritten")),
    ),
  );

describe("the camp brief projector", () => {
  // covers ADR 037 (Records, The hub's brain), CH-001, RT-001
  it.each<RuntimeKind>(["claude-code", "codex"])(
    "[TC-CH-1384-09] on %s under No AI, a chapter end writes the plain brief from decisions and artifacts, no model is called, and the next session reads it",
    async (runtime) => {
      const id = await start(runtime, NoAi);
      const reply = await say(id, "Plan the launch emails.");
      await decide(id, "a", "Emails go out on Wednesdays.");
      await wrote(reply, "launch.md");
      // No chapter has ended, so nothing asks for a brief yet.
      expect(await projectOnce()).toBe(true);
      expect(await briefOf(id)).toBeNull();

      await startChapter(id, "chapter-2", "Sending");
      expect(await projectOnce()).toBe(true);
      const brief = await briefOf(id);
      expect(brief).toMatchObject({
        text: "Decided:\n- Emails go out on Wednesdays.\n\nMade:\n- launch.md (doc, version 1)",
        writtenBy: { kind: "hub", id: "hub" },
        source: "rule",
      });
      expect((await run(MemoryModelEndpoint.use((endpoint) => endpoint.hubUsage))).calls).toBe(0);

      // The new chapter's first session reads it from the pack.
      await say(id, "When do they go out?");
      const told = (asked[runtime].at(-1) as PromptRequest).briefing ?? "";
      expect(told).toContain(`## This camp's brief\n\n${brief?.text}`);
    },
  );

  // covers ADR 037 (Records), STD-ARCH-016
  it("[TC-CH-1384-10] resumes from its cursor after a restart and writes nothing twice", async () => {
    const id = await start(
      "claude-code",
      scriptedBrain(() => Effect.succeed(brain("Dates are settled; emails next."))),
    );
    await say(id, "Plan the launch emails.");
    await decide(id, "a", "Emails go out on Wednesdays.");
    await startChapter(id, "chapter-2", "Sending");
    await projectOnce();
    expect(await briefOf(id)).toMatchObject({ text: "Dates are settled; emails next.", source: "brain" });
    expect(await briefEntries()).toHaveLength(1);

    // A restarted projector resumes from its cursor; one sent back to the start replays the
    // journal and writes nothing twice.
    await projectOnce();
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE projector_cursors SET sequence = 0 WHERE name = 'camp-briefs'`;
      }),
    );
    await projectOnce();
    expect(await briefEntries()).toHaveLength(1);
  });

  // covers ADR 037 (The hub's brain), STD-ARCH-016
  it("[TC-CH-1384-11] a failed or slow brain leaves the last brief in place and never holds up a turn", async () => {
    let next: () => Effect.Effect<Decided<string>> = () => Effect.succeed(brain("Dates are settled."));
    const id = await start(
      "claude-code",
      scriptedBrain(() => next()),
    );
    await say(id, "Plan the launch emails.");
    await decide(id, "a", "Emails go out on Wednesdays.");
    await startChapter(id, "chapter-2", "Sending");
    await projectOnce();
    expect((await briefOf(id))?.text).toBe("Dates are settled.");

    // The brain answers out of shape: its rule stands in, and the last brief stays.
    next = () => Effect.succeed({ choice: "Decided:\n- Emails go out on Wednesdays.", confidence: 1, by: "fallback" });
    await say(id, "Now the subject lines.");
    await startChapter(id, "chapter-3", "Subjects");
    expect(await projectOnce()).toBe(true);
    expect((await briefOf(id))?.text).toBe("Dates are settled.");

    // The brain is slow: a turn runs and ends while it thinks, and after its time is up the last
    // brief is still in place.
    let reached = () => {};
    const atBrain = new Promise<void>((resolve) => {
      reached = resolve;
    });
    next = () =>
      Effect.gen(function* () {
        reached();
        return yield* Effect.never;
      });
    await say(id, "Subjects are short.");
    await startChapter(id, "chapter-4", "Images");
    const round = projectOnce();
    await atBrain;
    const answered = await say(id, "Which images?");
    expect(answered.role).toBe("assistant");
    expect(await round).toBe(true);
    expect((await briefOf(id))?.text).toBe("Dates are settled.");
    expect(await briefEntries()).toHaveLength(1);
  });

  // covers ADR 037 (Records, Quests in camps)
  it("[TC-CH-1384-12] a Quest's milestone writes its camp's brief again", async () => {
    let said = "Started on the emails.";
    const id = await start(
      "claude-code",
      scriptedBrain(() => Effect.succeed(brain(said))),
    );
    await run(
      Effect.gen(function* () {
        const tasks = yield* TaskRepository;
        yield* tasks.createTask({
          task: {
            id: TaskId.make("emails"),
            ownerId: WREN,
            parentId: null,
            threadId: id,
            brief: "Write the launch emails",
            dependsOn: [],
            createdAt: NOW,
          },
          delegation: null,
          milestones: [{ id: MilestoneId.make("drafted"), title: "Drafted" }],
        });
        yield* tasks.startQuest({
          id: QuestId.make("q1"),
          taskId: TaskId.make("emails"),
          goal: "Send the launch emails",
          acceptance: [],
          limits: { maxDepth: 2, deadline: null },
          createdAt: NOW,
        });
      }),
    );
    await projectOnce();
    expect((await briefOf(id))?.text).toBe("Started on the emails.");

    said = "The emails are drafted.";
    await run(
      TaskRepository.use((tasks) =>
        tasks.recordCheckpoint({
          id: CheckpointId.make("c1"),
          taskId: TaskId.make("emails"),
          source: "planned",
          kind: "milestone",
          milestoneId: MilestoneId.make("drafted"),
          summary: "Drafted",
          createdAt: NOW,
        }),
      ),
    );
    await projectOnce();
    expect((await briefOf(id))?.text).toBe("The emails are drafted.");
    expect(await briefEntries()).toHaveLength(2);
  });

  // covers ADR 037 (Records), ADR 028
  it("[TC-CH-1384-13] a private camp's brief stays in that camp: memory capture takes nothing of it, and another thread's pack never reads it", async () => {
    const chat = await start("claude-code", NoAi);
    const camp = await run(
      ChatService.use((service) =>
        service.makeCamp(WREN, { key: "secret" as ThreadId, title: "Surprise party", goal: null, private: true }),
      ),
    );
    await say(camp.id, "Plan a surprise party for Ana.");
    await decide(camp.id, "cake", "The surprise cake is chocolate.");
    await startChapter(camp.id, "camp-2", "The cake");
    await projectOnce();

    const [written] = await briefEntries();
    expect(written?.payload).toMatchObject({ _tag: "BriefWritten", brief: { threadId: camp.id } });
    expect(capturedEntryOf(written as NonNullable<typeof written>, makeRedactor())).toBeNull();

    await say(camp.id, "Candles?");
    expect(asked["claude-code"].at(-1)?.briefing).toContain("The surprise cake is chocolate.");
    await say(chat, "Hello");
    const elsewhere = await run(ChatService.use((service) => service.contextPack(chat)));
    expect(elsewhere.next.text ?? "").not.toContain("surprise");
  });
});
