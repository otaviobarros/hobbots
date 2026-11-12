import { CampSuggestionService, ChatService } from "@hobbots/agents";
import {
  CampSuggestionChangeRefused,
  ChapterMissing,
  ChapterMoveRefused,
  HobbotsApi,
  type MoveChapterPayload,
} from "@hobbots/api";
import type { ChapterRefused } from "@hobbots/domain";
import { Effect, Option } from "effect";
import { HttpApiBuilder } from "effect/http-api";

/** The move as ChatService takes it. */
const moveRequest = (payload: MoveChapterPayload) =>
  payload._tag === "camp"
    ? ({ _tag: "camp", campId: payload.campId } as const)
    : ({ _tag: "new", key: payload.key, title: payload.title, goal: payload.goal, private: payload.private } as const);

/** A refused move, as the API answers it. */
const moveRefused = (refused: ChapterRefused) =>
  Effect.fail(new ChapterMoveRefused({ threadId: refused.threadId, reason: refused.reason }));

// Camp suggestions and moving a chapter into a camp (ADR 037, #1385), for user sessions only (PE-006).
export const CampSuggestionsHandlers = HttpApiBuilder.group(HobbotsApi, "campSuggestions", (handlers) =>
  Effect.gen(function* () {
    // A hub without camp suggestions, as in some tests, offers none.
    const suggestions = Option.getOrElse(yield* Effect.serviceOption(CampSuggestionService), () =>
      CampSuggestionService.of({
        listOpen: () => Effect.succeed([]),
        keep: () => Effect.die(new Error("This hub keeps no camp suggestions.")),
      }),
    );
    const chat = yield* ChatService;
    return handlers.handleAll({
      campSuggestions: ({ params }) => suggestions.listOpen(params.threadId),
      keepInChat: ({ params }) =>
        suggestions.keep(params.threadId, params.suggestionId).pipe(
          Effect.catchTag("CampSuggestionRefused", (refused) =>
            Effect.fail(
              new CampSuggestionChangeRefused({
                threadId: params.threadId,
                suggestionId: refused.suggestionId,
                reason: refused.reason,
              }),
            ),
          ),
        ),
      moveChapter: ({ params, payload }) =>
        chat.moveChapter(params.threadId, params.chapterId, moveRequest(payload)).pipe(
          Effect.catchTag("ChapterRefused", moveRefused),
          Effect.catchTag("ChapterNotFound", (missing) =>
            Effect.fail(new ChapterMissing({ threadId: missing.threadId, chapterId: missing.chapterId })),
          ),
          // A chapter's state that refuses the move is one moved already: the planner checks it first.
          Effect.catchTag("IllegalChapterTransition", () =>
            Effect.fail(new ChapterMoveRefused({ threadId: params.threadId, reason: "moved" })),
          ),
        ),
    });
  }),
);
