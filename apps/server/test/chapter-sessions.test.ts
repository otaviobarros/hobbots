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
import { Effect, Layer, ManagedRuntime, Option, Stream } from "effect";
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

/** Splits the chapter the prompt `content` is in at that prompt, into chapter `chapter`. */
const splitAt = async (id: ThreadId, content: string, chapter: string) => {
  const prompt = (await run(HobbotsRepository.use((repo) => repo.listMessages(id)))).find(
    (m) => m.role === "user" && m.content === content,
  ) as Message;
  return run(
    ChapterService.use((chapters) =>
      chapters.splitChapter(id, { id: ChapterId.make(chapter), messageId: prompt.id, title: "Split off" }),
    ),
  );
};

const merge = (id: ThreadId, chapter: string) =>
  run(ChapterService.use((chapters) => chapters.mergeChapters(id, ChapterId.make(chapter))));

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
      // Nothing of the first chapter is replayed into the new session (ADR 037): its pack names the
      // chapter in one line, and quotes none of its messages.
      expect(fresh.briefing).toContain("- Chapter 1: 4 messages, starting with “My cat is called Miso.”");
      expect(fresh.briefing).not.toContain("She is three.");
      expect(fresh.briefing).not.toContain("> My cat is called Miso.");
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
    expect(briefed.briefing).toContain("> She is three.");
    // The earlier chapter is one line of the pack, never replayed.
    expect(briefed.briefing).toContain("- Chapter 1: 2 messages, starting with “My cat is called Miso.”");
    expect(briefed.briefing).not.toContain("> My cat is called Miso.");
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

  // covers ADR 037 (Chapters)
  it("[TC-CH-1379-04] merging a split-off live chapter back before any turn in it starts a new session", async () => {
    const id = await start("claude-code");
    await say(id, "My cat is called Miso.");
    await say(id, "What should I plant?");
    const kept = liveSession(await thread(id), "claude-code");
    expect(kept?.sessionId).toMatch(/^fake-/);

    await splitAt(id, "What should I plant?", "garden");
    await merge(id, "garden");
    const merged = await thread(id);
    expect(merged.liveChapterId).toBe(kept?.chapterId);
    // The live chapter's old session is dropped, not resumed.
    expect(liveSession(merged, "claude-code")).toBeUndefined();
    await say(id, "Thanks.");
    expect(asked["claude-code"][2]?.sessionId).toBeNull();
  });

  // covers ADR 037 (Chapters)
  it("[TC-CH-1379-05] a turn under way while its chapter is split and merged back keeps no session for it", async () => {
    const id = await start("claude-code");
    await say(id, "My cat is called Miso.");
    let release = () => {};
    held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await run(ChatService.use((chat) => chat.sendPrompt(id, "What should I plant?")));
    await vi.waitFor(() => expect(asked["claude-code"]).toHaveLength(2));

    await splitAt(id, "What should I plant?", "garden");
    await merge(id, "garden");
    held = null;
    release();
    await vi.waitFor(async () => {
      const all = await run(HobbotsRepository.use((repo) => repo.listMessages(id)));
      expect(all.some((m) => isInProgress(m.status) || m.status === "queued")).toBe(false);
    });

    expect(liveSession(await thread(id), "claude-code")).toBeUndefined();
    await say(id, "Thanks.");
    expect(asked["claude-code"][2]?.sessionId).toBeNull();
  });

  // covers ADR 037 (Chapters), ADR 017, STD-ARCH-018
  it("[TC-CH-1379-06] a brain switch after a split is not briefed from a summary of the chapter before it", async () => {
    const id = await start("claude-code");
    const filler = "about the garden beds and what grows in them ".repeat(110);
    await say(id, `Miso is my cat. ${filler}`);
    for (let n = 1; n <= 6; n++) await say(id, `Garden note ${n}. ${filler}`);
    // A switch replays the live chapter as its pack, newest first, and counts what it left out.
    await run(ChatService.use((chat) => chat.setBrain(id, { runtime: "codex", model: null, effort: null })));
    await say(id, "Where were we?");
    expect(asked.codex[0]?.briefing).toContain("## This chapter so far");

    // The split leaves Miso in the chapter before the new live one.
    await splitAt(id, `Garden note 1. ${filler}`, "garden");
    await run(ChatService.use((chat) => chat.setBrain(id, { runtime: "claude-code", model: null, effort: null })));
    await say(id, "And now?");
    const briefed = asked["claude-code"].at(-1) as PromptRequest;
    expect(briefed.sessionId).toBeNull();
    // The first chapter is one line of the pack, no summary line of its messages. Miso is still
    // quoted in Codex's reply, which echoed its own briefing and is in the live chapter.
    expect(briefed.briefing).toMatch(/^- Chapter 1: 2 messages, starting with “Miso is my cat\./m);
    expect(briefed.briefing).not.toMatch(/^- User: “Miso/m);
  });
});
