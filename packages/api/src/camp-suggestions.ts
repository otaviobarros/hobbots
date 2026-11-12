import {
  CampSuggestion,
  CampSuggestionId,
  CampSuggestionRefusal,
  ChapterId,
  ChapterMove,
  ChapterRefusal,
  ThreadId,
} from "@hobbots/domain";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { MakeCampPayload } from "./camp-payloads.ts";
import { HobUnavailable, ThreadKeyReused, ThreadNotFound } from "./errors.ts";
import { DeviceSession } from "./user-session.ts";

/**
 * Where you move a chapter (ADR 037, #1385): into an open camp of the hob's, or into a new camp
 * made with it, as Make a camp takes it, whose `key` becomes the camp's id.
 */
export const MoveChapterPayload = Schema.Union([
  Schema.TaggedStruct("camp", { campId: ThreadId }),
  Schema.TaggedStruct("new", MakeCampPayload.fields),
]);
export type MoveChapterPayload = typeof MoveChapterPayload.Type;

/** A move that changed nothing, with why (`ChapterRefusal`). */
export class ChapterMoveRefused extends Schema.TaggedError<ChapterMoveRefused>()(
  "ChapterMoveRefused",
  { threadId: ThreadId, reason: ChapterRefusal },
  { httpApiStatus: 409 },
) {}

/** The chapter to move is not in the thread. */
export class ChapterMissing extends Schema.TaggedError<ChapterMissing>()(
  "ChapterMissing",
  { threadId: ThreadId, chapterId: ChapterId },
  { httpApiStatus: 404 },
) {}

/** Keep in chat that changed nothing: the suggestion is not in the chat, or was accepted or expired. */
export class CampSuggestionChangeRefused extends Schema.TaggedError<CampSuggestionChangeRefused>()(
  "CampSuggestionChangeRefused",
  { threadId: ThreadId, suggestionId: CampSuggestionId, reason: CampSuggestionRefusal },
  { httpApiStatus: 409 },
) {}

/**
 * Camp suggestions and moving a chapter into a camp (ADR 037, #1385). A chat's suggestions are
 * raised by the hub; you keep the chapter in the chat or move it, which accepts its suggestion.
 */
export class CampSuggestionsGroup extends HttpApiGroup.make("campSuggestions")
  .add(
    // The suggestions the chat still offers, oldest first.
    HttpApiEndpoint.get("campSuggestions", "/threads/:threadId/camp-suggestions", {
      params: { threadId: ThreadId },
      success: Schema.Array(CampSuggestion),
      error: ThreadNotFound,
    }),
    // Keeping a suggestion kept already returns it unchanged.
    HttpApiEndpoint.post("keepInChat", "/threads/:threadId/camp-suggestions/:suggestionId/keep", {
      params: { threadId: ThreadId, suggestionId: CampSuggestionId },
      success: CampSuggestion,
      error: [ThreadNotFound, CampSuggestionChangeRefused],
    }),
    // The same move asked again returns what it did.
    HttpApiEndpoint.post("moveChapter", "/threads/:threadId/chapters/:chapterId/move", {
      params: { threadId: ThreadId, chapterId: ChapterId },
      payload: MoveChapterPayload,
      success: ChapterMove,
      error: [ThreadNotFound, ChapterMissing, ChapterMoveRefused, HobUnavailable, ThreadKeyReused],
    }),
  )
  .middleware(DeviceSession)
  .prefix("/api") {}
