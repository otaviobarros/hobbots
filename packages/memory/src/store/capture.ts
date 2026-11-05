import { createHash } from "node:crypto";
import type { MemoryCaptureItem, ThreadId } from "@hobbots/domain";
import { Schema } from "effect";
import type { EngineProject } from "./scopes.ts";

/**
 * Capture on ai-memory (ADR 028, Capture and summaries): what happened in a thread, sent to
 * `/hook/batch` as lifecycle events of one ai-memory session, the thread's. Hobbots is the producer
 * (`extension=hobbots`) and the agent, whichever brain wrote a reply, so a brain switch never splits
 * the session. A message of yours is a prompt, a reply ends a turn (`stop`), a tool step and a Quest
 * are events of Hobbots' own vocabulary, and the end of the session (`session-end`) has ai-memory
 * write its summary page, `sessions/<thread id>.md`.
 */

/** Hobbots' producer name, in every event's `agent` and `extension`. */
const PRODUCER = "hobbots";

/** The most events ai-memory takes in one batch. */
export const HOOK_BATCH_MAX = 256;

type Kind = MemoryCaptureItem["kind"] | "end";

const EVENTS: Record<Kind, string> = {
  start: "session-start",
  message: "user-prompt-submit",
  reply: "stop",
  // Not lifecycle events: ai-memory keeps them as `other`, with Hobbots' name for them.
  tool: "tool-step",
  quest: "quest",
  end: "session-end",
};

/**
 * ai-memory's ingest key for an item: 64 hex characters (its rules allow 1 to 64 letters, digits,
 * `_` or `-`), derived from the item's own key under the producer name, so the same item gets the
 * same key on every send and ai-memory skips a replay for 30 days.
 */
const ingestKeyOf = (key: string): string =>
  createHash("sha256")
    .update(JSON.stringify(["hobbots-capture-v1", PRODUCER, key]), "utf8")
    .digest("hex");

/** The longest title an event carries: the first line of its text. */
const TITLE_MAX = 200;

const titleOf = (text: string) => {
  const line = text.split("\n", 1)[0]?.trim() ?? "";
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1)}…` : line;
};

const bodyOf = (kind: Kind, text: string): Record<string, unknown> => {
  if (kind === "end") return {};
  if (kind === "message") return { prompt: text };
  return { title: titleOf(text), body: text };
};

/** One event of the thread's session, as `/hook/batch` takes it. */
export const hookEventOf = (
  where: EngineProject,
  threadId: ThreadId,
  item: { readonly kind: Kind; readonly key: string; readonly text: string },
) => {
  const query = new URLSearchParams({
    event: EVENTS[item.kind],
    agent: PRODUCER,
    workspace: where.workspace,
    project: where.project,
    extension: PRODUCER,
    source_event: item.kind,
    ingest_key: ingestKeyOf(item.key),
    // A thread's end writes its summary page and nothing else: no handoff waits for a next agent.
    ...(item.kind === "end" ? { auto_handoff: "false" } : {}),
  });
  return { url: `/hook?${query.toString()}`, body: { session_id: threadId, ...bodyOf(item.kind, item.text) } };
};

/** What `/hook/batch` answers, in the fields read. */
export const HookBatchJson = Schema.Struct({
  accepted: Schema.Number,
  accepted_indices: Schema.optionalKey(Schema.Array(Schema.Number)),
});

/**
 * How many of the first events ai-memory acknowledged: the indices it lists, when it does, up to the
 * first one missing, or its contiguous `accepted` count. A drop by policy is an acknowledgement too.
 */
export const acknowledgedPrefix = (json: typeof HookBatchJson.Type): number => {
  if (json.accepted_indices === undefined) return json.accepted;
  const acknowledged = new Set(json.accepted_indices);
  let prefix = 0;
  while (acknowledged.has(prefix)) prefix += 1;
  return prefix;
};
