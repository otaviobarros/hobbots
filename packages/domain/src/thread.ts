import { Effect, Schema } from "effect";
import { Brain, RuntimeSession } from "./brain.ts";
import { AgentId, ThreadId } from "./ids.ts";
import { Revision } from "./revision.ts";

export class Thread extends Schema.Class<Thread>("Thread")({
  id: ThreadId,
  agentId: AgentId,
  title: Schema.String,
  /**
   * One session per runtime the thread has used, kept separate from the thread's identity (ADR 017).
   * Thread events journaled before this carry none; their Claude Code session moved here in migration 0020.
   */
  sessions: Schema.Array(RuntimeSession).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([])),
    Schema.withConstructorDefault(Effect.succeed([])),
  ),
  /** The thread's own brain, or null to think with the hob's. A thread setting: it grants nothing. */
  brain: Schema.NullOr(Brain).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
    Schema.withConstructorDefault(Effect.succeed(null)),
  ),
  /**
   * When the thread was archived, or null while it is live. An archived thread is left out of thread
   * lists, takes no new messages until it is restored, and is still found by search.
   */
  archivedAt: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
    Schema.withConstructorDefault(Effect.succeed(null)),
  ),
  /**
   * The last message the transcript shows, as one line of at most `PREVIEW_LENGTH` characters, for
   * lists of chats. Worked out when the thread is read, never stored; null while it has none.
   */
  lastLine: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
    Schema.withConstructorDefault(Effect.succeed(null)),
  ),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  revision: Revision,
}) {}

/** How long a thread's last line runs before it is cut. */
export const PREVIEW_LENGTH = 140;

/** A message's text as one line, cut at `PREVIEW_LENGTH` with an ellipsis; null when it has none. */
export const previewLine = (content: string): string | null => {
  const line = content.replace(/\s+/g, " ").trim();
  if (line.length === 0) return null;
  return line.length > PREVIEW_LENGTH ? `${line.slice(0, PREVIEW_LENGTH - 1).trimEnd()}…` : line;
};

/**
 * The line a message gives its thread's preview: null for a queued message, which the transcript
 * does not show yet, and for one with no text, such as a reply made only of tool calls.
 */
export const messagePreview = (message: { readonly content: string; readonly status: string }): string | null =>
  message.status === "queued" ? null : previewLine(message.content);

export const DEFAULT_THREAD_TITLE = "New thread";
const TITLE_MAX = 60;

/** Derives a thread title from the first prompt, collapsed to one line. */
export const titleFromPrompt = (prompt: string): string => {
  const line = prompt.replace(/\s+/g, " ").trim();
  if (line.length === 0) return DEFAULT_THREAD_TITLE;
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1).trimEnd()}…` : line;
};
