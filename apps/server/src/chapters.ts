import { ChapterService, ChatService, PackReports } from "@hobbots/agents";
import {
  type ChapterChangeRefusal,
  ChapterChangeRefused,
  type FocusRead,
  HobbotsApi,
  type ChannelNotFound,
} from "@hobbots/api";
import type { ChannelId } from "@hobbots/domain";
import { Effect, Option } from "effect";
import { HttpApiBuilder } from "effect/http-api";

// A channel's chapters (ADR 037, #1382): read, split here and merge with the previous one, and what
// the Focus chip shows. Each command runs through `ChapterService`, under the channel's hob lock.
export const ChaptersHandlers = HttpApiBuilder.group(HobbotsApi, "chapters", (handlers) =>
  Effect.gen(function* () {
    // The hub always has its chapters (main.ts). A test hub built without them serves every other
    // route, and these die, so a test that reaches them without chapters fails loudly.
    const chapters = Option.getOrElse(yield* Effect.serviceOption(ChapterService), () =>
      ChapterService.of({
        listChapters: () => Effect.die("This hub was built without its chapters"),
        startChapter: () => Effect.die("This hub was built without its chapters"),
        splitChapter: () => Effect.die("This hub was built without its chapters"),
        mergeChapters: () => Effect.die("This hub was built without its chapters"),
      }),
    );
    const chat = yield* ChatService;
    const reports = yield* Effect.serviceOption(PackReports);

    const refused = (channelId: ChannelId, reason: ChapterChangeRefusal) =>
      Effect.fail(new ChapterChangeRefused({ channelId, reason }));
    // A refusal keeps its reason. A change its states do not allow can only touch a chapter that
    // moved into a camp, since every other chapter is live or resting.
    const refusals = (channelId: ChannelId) => ({
      ChapterRefused: (e: { readonly reason: ChapterChangeRefusal }) => refused(channelId, e.reason),
      IllegalChapterTransition: () => refused(channelId, "moved"),
      ChapterNotFound: () => refused(channelId, "chapter-not-found"),
    });

    // The report of the pack the channel's last new session read; without one, the next one's.
    const focus = (channelId: ChannelId): Effect.Effect<FocusRead, ChannelNotFound> =>
      Effect.gen(function* () {
        const last = Option.isNone(reports) ? Option.none() : yield* reports.value.last(channelId);
        if (Option.isSome(last)) {
          // A channel that is gone has no Focus, even when a report of it is still kept.
          yield* chapters.listChapters(channelId);
          return { of: "last-turn", report: last.value };
        }
        const { next } = yield* chat.contextPack(channelId);
        return { of: "next-session", report: next.report };
      });

    return handlers.handleAll({
      list: ({ params }) => chapters.listChapters(params.channelId),
      split: ({ params, payload }) =>
        chapters
          .splitChapter(params.channelId, { id: payload.key, messageId: payload.messageId, title: payload.title })
          .pipe(
            Effect.map((plan) => plan.chapters),
            Effect.catchTags(refusals(params.channelId)),
          ),
      merge: ({ params }) =>
        chapters.mergeChapters(params.channelId, params.chapterId).pipe(
          Effect.map((plan) => plan.chapters),
          Effect.catchTags(refusals(params.channelId)),
        ),
      focus: ({ params }) => focus(params.channelId),
    });
  }),
);
