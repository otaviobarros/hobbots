import { ThreadNotFound } from "@hobbots/api";
import {
  type Chapter,
  type ChapterId,
  type ChapterNotFound,
  type ChapterPlan,
  ChapterRefused,
  type Committed,
  type IllegalChapterTransition,
  type MessageId,
  type ThreadId,
  ThreadLifecycle,
} from "@hobbots/domain";
import { Context, DateTime, Effect, Layer, Option } from "effect";
import { HobAdmission } from "./admission.ts";
import { announcer, EventPublisher } from "./ports.ts";
import { HobbotsRepository } from "./repository.ts";

/** Where a thread's chapters are kept (ADR 037). Each command runs its rules and journals its event in one transaction. */
export class ChapterRepository extends Context.Service<
  ChapterRepository,
  {
    /** The thread's chapters in order, moved ones included. */
    readonly listChapters: (threadId: ThreadId) => Effect.Effect<ReadonlyArray<Chapter>>;
    /**
     * Ends the live chapter and starts chapter `id`, journaled as `ChapterStarted`. `id` is the
     * command's idempotency key: once the chapter exists, the same command changes nothing.
     */
    readonly startChapter: (
      threadId: ThreadId,
      input: { readonly id: ChapterId; readonly title: string; readonly at: string },
    ) => Effect.Effect<Committed<ChapterPlan>, ChapterRefused | IllegalChapterTransition>;
    /**
     * Cuts the chapter `messageId` is in, so its messages from there on make chapter `id`, journaled
     * as `ChapterSplit`. `id` is the idempotency key, as for `startChapter`.
     */
    readonly splitChapter: (
      threadId: ThreadId,
      input: { readonly id: ChapterId; readonly messageId: MessageId; readonly title: string },
    ) => Effect.Effect<Committed<ChapterPlan>, ChapterRefused | IllegalChapterTransition>;
    /**
     * Merges `chapterId` into the chapter before it, journaled as `ChapterMerged`. Merging a chapter
     * that was already merged changes nothing.
     */
    readonly mergeChapters: (
      threadId: ThreadId,
      chapterId: ChapterId,
    ) => Effect.Effect<Committed<ChapterPlan>, ChapterRefused | ChapterNotFound | IllegalChapterTransition>;
  }
>()("@hobbots/agents/ChapterRepository") {}

type ChapterErrors = ThreadNotFound | ChapterRefused | ChapterNotFound | IllegalChapterTransition;

/**
 * The chapter commands (ADR 037): start, split and merge. The hob ends a chapter with `start_chapter`
 * (#1381) and you split or merge them (#1382). Each runs under the thread's hob lock, so an archive
 * cannot land between the check and the change, and is announced once committed. A new chapter
 * starts a new runtime session on its next turn, on every runtime, since sessions are keyed by chapter.
 */
export class ChapterService extends Context.Service<
  ChapterService,
  {
    readonly listChapters: (threadId: ThreadId) => Effect.Effect<ReadonlyArray<Chapter>, ThreadNotFound>;
    readonly startChapter: (
      threadId: ThreadId,
      input: { readonly id: ChapterId; readonly title: string },
    ) => Effect.Effect<ChapterPlan, ChapterErrors>;
    readonly splitChapter: (
      threadId: ThreadId,
      input: { readonly id: ChapterId; readonly messageId: MessageId; readonly title: string },
    ) => Effect.Effect<ChapterPlan, ChapterErrors>;
    readonly mergeChapters: (threadId: ThreadId, chapterId: ChapterId) => Effect.Effect<ChapterPlan, ChapterErrors>;
  }
>()("@hobbots/agents/ChapterService") {
  static readonly layer = Layer.effect(
    ChapterService,
    Effect.gen(function* () {
      const chapters = yield* ChapterRepository;
      const repo = yield* HobbotsRepository;
      const admission = yield* HobAdmission;
      const announce = announcer(yield* Effect.serviceOption(EventPublisher), "a chapter change");

      // Runs `command` on an open thread under its hob's lock, then announces what it committed.
      const onOpenThread = <E>(
        threadId: ThreadId,
        command: Effect.Effect<Committed<ChapterPlan>, E>,
      ): Effect.Effect<ChapterPlan, E | ThreadNotFound | ChapterRefused> =>
        Effect.gen(function* () {
          const found = yield* repo.findThread(threadId);
          if (Option.isNone(found)) return yield* new ThreadNotFound({ threadId });
          const committed = yield* admission.withHob(
            found.value.agentId,
            Effect.gen(function* () {
              const thread = yield* repo.findThread(threadId);
              if (Option.isNone(thread)) return yield* new ThreadNotFound({ threadId });
              if (!ThreadLifecycle.isOpen(thread.value)) {
                return yield* new ChapterRefused({ threadId, reason: "thread-closed" });
              }
              return yield* command;
            }),
          );
          yield* announce(committed.entries);
          return committed.value;
        });

      return ChapterService.of({
        listChapters: (threadId) =>
          Effect.gen(function* () {
            if (Option.isNone(yield* repo.findThread(threadId))) return yield* new ThreadNotFound({ threadId });
            return yield* chapters.listChapters(threadId);
          }),
        startChapter: (threadId, input) =>
          onOpenThread(
            threadId,
            DateTime.now.pipe(
              Effect.flatMap((now) => chapters.startChapter(threadId, { ...input, at: DateTime.formatIso(now) })),
            ),
          ),
        splitChapter: (threadId, input) => onOpenThread(threadId, chapters.splitChapter(threadId, input)),
        mergeChapters: (threadId, chapterId) => onOpenThread(threadId, chapters.mergeChapters(threadId, chapterId)),
      });
    }),
  );
}
