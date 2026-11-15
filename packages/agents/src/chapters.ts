import { ChannelNotFound } from "@hobbots/api";
import {
  type CampSuggestionId,
  type ChannelId,
  ChannelLifecycle,
  type Chapter,
  type ChapterId,
  type ChapterNotFound,
  type ChapterPlan,
  ChapterRefused,
  type Committed,
  type IllegalChapterTransition,
  type MessageId,
} from "@hobbots/domain";
import { Context, DateTime, Effect, Layer, Option } from "effect";
import { HobAdmission, withChannelLock } from "./admission.ts";
import { announcer, EventPublisher } from "./ports.ts";
import { HobbotsRepository } from "./repository.ts";

/** A split: the new chapter's id, the message it starts at, its title, and the suggestion it is made for. */
export interface SplitInput {
  readonly id: ChapterId;
  readonly messageId: MessageId;
  readonly title: string;
  readonly withdraw?: CampSuggestionId;
  /**
   * For a split the hub judged: the chapter it judged, at the revision it read, and the highest
   * revision of its messages when the judgment read them all.
   */
  readonly judged?: { readonly chapterId: ChapterId; readonly revision: number; readonly messagesRevision?: number };
}

/** Where a channel's chapters are kept (ADR 037). Each command runs its rules and journals its event in one transaction. */
export class ChapterRepository extends Context.Service<
  ChapterRepository,
  {
    /** The channel's chapters in order, moved ones included. */
    readonly listChapters: (channelId: ChannelId) => Effect.Effect<ReadonlyArray<Chapter>>;
    /**
     * Ends the live chapter and starts chapter `id`, journaled as `ChapterStarted`. `id` is the
     * command's idempotency key: once the chapter exists, the same command changes nothing.
     */
    readonly startChapter: (
      channelId: ChannelId,
      input: { readonly id: ChapterId; readonly title: string; readonly at: string },
    ) => Effect.Effect<Committed<ChapterPlan>, ChapterRefused | IllegalChapterTransition>;
    /**
     * Cuts the chapter `messageId` is in, so its messages from there on make chapter `id`, journaled
     * as `ChapterSplit`. `id` is the idempotency key, as for `startChapter`. In the same
     * transaction (#1557), the cut chapter's pending camp suggestion is withdrawn when it is `withdraw`,
     * the one the hub split it for, or when its thresholds no longer hold; and chapter `id` is
     * suggested if it reaches a threshold on its own. A split with `judged` is refused as
     * `chapter-changed` when the message is no longer in that chapter as it was judged.
     */
    readonly splitChapter: (
      channelId: ChannelId,
      input: SplitInput,
    ) => Effect.Effect<Committed<ChapterPlan>, ChapterRefused | IllegalChapterTransition>;
    /**
     * Merges `chapterId` into the chapter before it, journaled as `ChapterMerged`. Merging a chapter
     * that was already merged changes nothing.
     */
    readonly mergeChapters: (
      channelId: ChannelId,
      chapterId: ChapterId,
    ) => Effect.Effect<Committed<ChapterPlan>, ChapterRefused | ChapterNotFound | IllegalChapterTransition>;
  }
>()("@hobbots/agents/ChapterRepository") {}

type ChapterErrors = ChannelNotFound | ChapterRefused | ChapterNotFound | IllegalChapterTransition;

/**
 * The chapter commands (ADR 037): start, split and merge. The hob ends a chapter with `start_chapter`
 * (#1381) and you split or merge them (#1382). Each runs under the channel's hob lock, so an archive
 * cannot land between the check and the change, and is announced once committed. A new chapter
 * starts a new runtime session on its next turn, on every runtime, since sessions are keyed by chapter.
 */
export class ChapterService extends Context.Service<
  ChapterService,
  {
    readonly listChapters: (channelId: ChannelId) => Effect.Effect<ReadonlyArray<Chapter>, ChannelNotFound>;
    readonly startChapter: (
      channelId: ChannelId,
      input: { readonly id: ChapterId; readonly title: string },
    ) => Effect.Effect<ChapterPlan, ChapterErrors>;
    readonly splitChapter: (channelId: ChannelId, input: SplitInput) => Effect.Effect<ChapterPlan, ChapterErrors>;
    readonly mergeChapters: (channelId: ChannelId, chapterId: ChapterId) => Effect.Effect<ChapterPlan, ChapterErrors>;
  }
>()("@hobbots/agents/ChapterService") {
  static readonly layer = Layer.effect(
    ChapterService,
    Effect.gen(function* () {
      const chapters = yield* ChapterRepository;
      const repo = yield* HobbotsRepository;
      const admission = yield* HobAdmission;
      const announce = announcer(yield* Effect.serviceOption(EventPublisher), "a chapter change");

      // Runs `command` on an open channel under its hob's lock, then announces what it committed.
      const onOpenChannel = <E>(
        channelId: ChannelId,
        command: Effect.Effect<Committed<ChapterPlan>, E>,
      ): Effect.Effect<ChapterPlan, E | ChannelNotFound | ChapterRefused> =>
        Effect.gen(function* () {
          const found = yield* repo.findChannel(channelId);
          if (Option.isNone(found)) return yield* new ChannelNotFound({ channelId });
          const committed = yield* withChannelLock(
            admission,
            found.value,
            Effect.gen(function* () {
              const channel = yield* repo.findChannel(channelId);
              if (Option.isNone(channel)) return yield* new ChannelNotFound({ channelId });
              if (!ChannelLifecycle.isOpen(channel.value)) {
                return yield* new ChapterRefused({ channelId, reason: "channel-closed" });
              }
              return yield* command;
            }),
          );
          yield* announce(committed.entries);
          return committed.value;
        });

      return ChapterService.of({
        listChapters: (channelId) =>
          Effect.gen(function* () {
            if (Option.isNone(yield* repo.findChannel(channelId))) return yield* new ChannelNotFound({ channelId });
            return yield* chapters.listChapters(channelId);
          }),
        startChapter: (channelId, input) =>
          onOpenChannel(
            channelId,
            DateTime.now.pipe(
              Effect.flatMap((now) => chapters.startChapter(channelId, { ...input, at: DateTime.formatIso(now) })),
            ),
          ),
        splitChapter: (channelId, input) => onOpenChannel(channelId, chapters.splitChapter(channelId, input)),
        mergeChapters: (channelId, chapterId) => onOpenChannel(channelId, chapters.mergeChapters(channelId, chapterId)),
      });
    }),
  );
}
