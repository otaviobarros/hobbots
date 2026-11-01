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
  createdAt: Schema.String,
  updatedAt: Schema.String,
  revision: Revision,
}) {}

export const DEFAULT_THREAD_TITLE = "New thread";
const TITLE_MAX = 60;

/** Derives a thread title from the first prompt, collapsed to one line. */
export const titleFromPrompt = (prompt: string): string => {
  const line = prompt.replace(/\s+/g, " ").trim();
  if (line.length === 0) return DEFAULT_THREAD_TITLE;
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1).trimEnd()}…` : line;
};
