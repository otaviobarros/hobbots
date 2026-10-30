import { Schema } from "effect";
import { AgentId, ThreadId } from "./ids.ts";
import { Revision } from "./revision.ts";

export class Thread extends Schema.Class<Thread>("Thread")({
  id: ThreadId,
  agentId: AgentId,
  title: Schema.String,
  /** Runtime-owned session id (e.g. a Claude Code session), kept separate from the app identity. */
  runtimeSessionId: Schema.NullOr(Schema.String),
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
