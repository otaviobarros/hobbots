import {
  CHAPTER_TITLE_MAX,
  ChannelId,
  Chapter,
  ChapterId,
  ChapterRefusal,
  MessageId,
  PackReport,
} from "@hobbots/domain";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { ChannelNotFound } from "./errors.ts";
import { DeviceSession } from "./user-session.ts";

/**
 * Why a split or a merge changed nothing (ADR 037): a `ChapterRefusal`, or `chapter-not-found` when
 * the chapter to merge is not in the channel, as after another device merged it first.
 */
export const ChapterChangeRefusal = Schema.Literals([...ChapterRefusal.literals, "chapter-not-found"]);
export type ChapterChangeRefusal = typeof ChapterChangeRefusal.Type;

/** A split or a merge was refused for `reason`; the channel's chapters are as they were. */
export class ChapterChangeRefused extends Schema.TaggedError<ChapterChangeRefused>()(
  "ChapterChangeRefused",
  { channelId: ChannelId, reason: ChapterChangeRefusal },
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
 * What the Focus chip shows (ADR 037): the `PackReport` of the pack the channel's last new session
 * read (`last-turn`), or, when the hub kept none, as after a restart, the report of the pack its
 * next new session would read (`next-session`).
 */
export const FocusRead = Schema.Struct({
  of: Schema.Literals(["last-turn", "next-session"]),
  report: PackReport,
});
export type FocusRead = typeof FocusRead.Type;

/** A channel's chapters (ADR 037), and what its hob reads each turn. */
export class ChaptersGroup extends HttpApiGroup.make("chapters")
  .add(
    // The channel's chapters in order; each later change arrives as a chapter event.
    HttpApiEndpoint.get("list", "/channels/:channelId/chapters", {
      params: { channelId: ChannelId },
      success: Schema.Array(Chapter),
      error: ChannelNotFound,
    }),
    // Returns the channel's chapters after the split.
    HttpApiEndpoint.post("split", "/channels/:channelId/chapters/split", {
      params: { channelId: ChannelId },
      payload: SplitChapterPayload,
      success: Schema.Array(Chapter),
      error: [ChannelNotFound, ChapterChangeRefused],
    }),
    // Merges the chapter into the one before it; returns the channel's chapters after the merge.
    HttpApiEndpoint.post("merge", "/channels/:channelId/chapters/:chapterId/merge", {
      params: { channelId: ChannelId, chapterId: ChapterId },
      success: Schema.Array(Chapter),
      error: [ChannelNotFound, ChapterChangeRefused],
    }),
    HttpApiEndpoint.get("focus", "/channels/:channelId/focus", {
      params: { channelId: ChannelId },
      success: FocusRead,
      error: ChannelNotFound,
    }),
  )
  .middleware(DeviceSession)
  .prefix("/api") {}
