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
} from "@hobbots/agents";
import {
  Agent,
  AgentId,
  ChapterId,
  isInProgress,
  liveSession,
  type Message,
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
} from "@hobbots/persistence";
import { TestDatabase } from "@hobbots/persistence/testing";
import { makeFakeRuntime } from "@hobbots/runtimes";
import { Effect, Layer, ManagedRuntime, Option } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventBus } from "../src/event-bus.ts";
import { NodeFolderChecks } from "../src/folders.ts";

// Issue #1379 (ADR 037): a runtime session belongs to one chapter. A new chapter starts a new
// session on the next turn, on Claude Code and on Codex alike, and the old chapter's session is never
// resumed for it. A brain switch inside the live chapter is the only replay of the transcript, and
// it replays that chapter alone.

const NOW = "2026-11-11T00:00:00.000Z";
const WREN = AgentId.make("wren");

// What each runtime was asked, in order.
let asked: Record<RuntimeKind, Array<PromptRequest>>;

const recorded = (runtime: RuntimeKind, fake: RuntimeAdapterShape): RuntimeAdapterShape => ({
  ...fake,
  sendPrompt: (request) => {
    asked[runtime].push(request);
    return fake.sendPrompt(request);
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
  await hub?.dispose();
  hub = undefined;
});

const run = <A, E>(effect: Effect.Effect<A, E, Layer.Success<ReturnType<typeof hubLayer>>>) =>
  (hub as Hub).runPromise(effect);

/** A hub with Wren, thinking with `runtime`, and her chat. */
const start = async (runtime: RuntimeKind): Promise<ThreadId> => {
  asked = { "claude-code": [], codex: [] };
  hub = ManagedRuntime.make(hubLayer());
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

const startChapter = (id: ThreadId, chapter: string, title: string) =>
  run(ChapterService.use((chapters) => chapters.startChapter(id, { id: ChapterId.make(chapter), title })));

describe("runtime sessions keyed by chapter", () => {
  // covers ADR 037 (Chapters), RT-001
  it.each<RuntimeKind>(["claude-code", "codex"])(
    "[TC-CH-1379-01] on %s, a new chapter starts a new session and never resumes the old chapter's",
    async (runtime) => {
      const id = await start(runtime);
      await say(id, "My cat is called Miso.");
      const first = liveSession(await thread(id), runtime);
      expect(first?.sessionId).toMatch(/^fake-/);
      await say(id, "She is three.");
      expect(asked[runtime][1]?.sessionId).toBe(first?.sessionId);

      await startChapter(id, "chapter-2", "The garden");
      const moved = await thread(id);
      expect(moved.liveChapterId).toBe("chapter-2");
      // The first chapter's session is kept on the thread, but no turn of the new chapter resumes it.
      expect(liveSession(moved, runtime)).toBeUndefined();

      const reply = await say(id, "What should I plant?");
      const fresh = asked[runtime][2] as PromptRequest;
      expect(fresh.sessionId).toBeNull();
      // Nothing of the first chapter is replayed into the new session (ADR 037).
      expect(fresh.briefing ?? "").not.toContain("Miso");
      expect(reply).toMatchObject({ status: "complete", chapterId: "chapter-2" });
      const second = liveSession(await thread(id), runtime);
      expect(second).toMatchObject({ runtime, chapterId: "chapter-2" });
      expect(second?.sessionId).not.toBe(first?.sessionId);

      // Inside the new chapter, the next turn resumes the new session.
      await say(id, "And when?");
      expect(asked[runtime][3]?.sessionId).toBe(second?.sessionId);
      expect(asked[runtime].slice(2).map((request) => request.sessionId)).not.toContain(first?.sessionId);
      // The thread keeps one session per runtime, now the new chapter's.
      expect((await thread(id)).sessions.map((s) => [s.runtime, s.sessionId, s.chapterId])).toEqual([
        [runtime, second?.sessionId, "chapter-2"],
      ]);
    },
  );

  // covers ADR 037 (Chapters), ADR 017, RT-001
  it("[TC-CH-1379-02] a brain switch inside the live chapter is briefed with that chapter alone", async () => {
    const id = await start("claude-code");
    await say(id, "My cat is called Miso.");
    await startChapter(id, "chapter-2", "Her age");
    await say(id, "She is three.");
    await run(ChatService.use((chat) => chat.setBrain(id, { runtime: "codex", model: null, effort: null })));

    await say(id, "How old is she?");
    const briefed = asked.codex[0] as PromptRequest;
    expect(briefed.sessionId).toBeNull();
    expect(briefed.briefing).toContain("She is three.");
    expect(briefed.briefing).not.toContain("Miso");
  });

  // covers ADR 037 (Chapters)
  it("[TC-CH-1379-03] splitting the live chapter starts a new session; merging it back starts another", async () => {
    const id = await start("claude-code");
    await say(id, "My cat is called Miso.");
    const plants = await say(id, "What should I plant?");
    const before = liveSession(await thread(id), "claude-code");

    const prompt = (await run(HobbotsRepository.use((repo) => repo.listMessages(id)))).find(
      (m) => m.role === "user" && m.content === "What should I plant?",
    ) as Message;
    const split = await run(
      ChapterService.use((chapters) =>
        chapters.splitChapter(id, { id: ChapterId.make("garden"), messageId: prompt.id, title: "The garden" }),
      ),
    );
    expect(split.chapters.map((c) => [c.number, c.state])).toEqual([
      [1, "resting"],
      [2, "live"],
    ]);
    expect(
      (await run(HobbotsRepository.use((repo) => repo.listMessages(id)))).map((m) => [m.content, m.chapterId]),
    ).toEqual([
      ["My cat is called Miso.", plants.chapterId],
      [expect.any(String), plants.chapterId],
      ["What should I plant?", "garden"],
      [plants.content, "garden"],
    ]);
    await say(id, "When?");
    expect(asked["claude-code"][2]?.sessionId).toBeNull();
    const garden = liveSession(await thread(id), "claude-code");
    expect(garden?.sessionId).not.toBe(before?.sessionId);

    await run(ChapterService.use((chapters) => chapters.mergeChapters(id, ChapterId.make("garden"))));
    await say(id, "Thanks.");
    expect(asked["claude-code"][3]?.sessionId).toBeNull();
  });
});
