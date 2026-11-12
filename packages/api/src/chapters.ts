import {
  CHAPTER_TITLE_MAX,
  Chapter,
  ChapterId,
  ChapterRefusal,
  MessageId,
  PackReport,
  ThreadId,
} from "@hobbots/domain";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { ThreadNotFound } from "./errors.ts";
import { DeviceSession } from "./user-session.ts";

/**
 * Why a split or a merge changed nothing (ADR 037): a `ChapterRefusal`, or `chapter-not-found` when
 * the chapter to merge is not in the thread, as after another device merged it first.
 */
export const ChapterChangeRefusal = Schema.Literals([...ChapterRefusal.literals, "chapter-not-found"]);
export type ChapterChangeRefusal = typeof ChapterChangeRefusal.Type;

/** A split or a merge was refused for `reason`; the thread's chapters are as they were. */
export class ChapterChangeRefused extends Schema.TaggedError<ChapterChangeRefused>()(
  "ChapterChangeRefused",
  { threadId: ThreadId, reason: ChapterChangeRefusal },
  { httpApiStatus: 409 },
) {}

/**
 * Split here (ADR 037, #1382): the chapter `messageId` is in is cut there, and its messages from
 * there on make a new chapter titled `title`. `key` becomes the new chapter's id, so sending the
 * same request again, as a retry after a lost answer does, changes nothing.
 */
export const SplitChapterPayload = Schema.Struct({
  key: ChapterId.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(100)),
  messageId: MessageId,
  title: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(CHAPTER_TITLE_MAX)),
});
export type SplitChapterPayload = typeof SplitChapterPayload.Type;

/**
 * What the Focus chip shows (ADR 037): the `PackReport` of the pack the thread's last new session
 * read (`last-turn`), or, when the hub kept none, as after a restart, the report of the pack its
 * next new session would read (`next-session`).
 */
export const FocusRead = Schema.Struct({
  of: Schema.Literals(["last-turn", "next-session"]),
  report: PackReport,
});
export type FocusRead = typeof FocusRead.Type;

/** A thread's chapters (ADR 037), and what its hob reads each turn. */
export class ChaptersGroup extends HttpApiGroup.make("chapters")
  .add(
    // The thread's chapters in order; each later change arrives as a chapter event.
    HttpApiEndpoint.get("list", "/threads/:threadId/chapters", {
      params: { threadId: ThreadId },
      success: Schema.Array(Chapter),
      error: ThreadNotFound,
    }),
    // Returns the thread's chapters after the split.
    HttpApiEndpoint.post("split", "/threads/:threadId/chapters/split", {
      params: { threadId: ThreadId },
      payload: SplitChapterPayload,
      success: Schema.Array(Chapter),
      error: [ThreadNotFound, ChapterChangeRefused],
    }),
    // Merges the chapter into the one before it; returns the thread's chapters after the merge.
    HttpApiEndpoint.post("merge", "/threads/:threadId/chapters/:chapterId/merge", {
      params: { threadId: ThreadId, chapterId: ChapterId },
      success: Schema.Array(Chapter),
      error: [ThreadNotFound, ChapterChangeRefused],
    }),
    HttpApiEndpoint.get("focus", "/threads/:threadId/focus", {
      params: { threadId: ThreadId },
      success: FocusRead,
      error: ThreadNotFound,
    }),
  )
  .middleware(DeviceSession)
  .prefix("/api") {}
