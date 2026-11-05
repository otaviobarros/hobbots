import { Schema } from "effect";
import { AgentId, MessageId, ThreadId } from "./ids.ts";
import { MemoryPath, MemoryScope, MemoryVersion } from "./memory.ts";

/**
 * Shares (ADR 028, Sharing): a `memory_save` that asks to put a page beyond the hob's own memory,
 * into a project's or everyone's. The safety preset decides it: under Careful and Balanced it waits
 * for your review, under Trusting a share to a project goes through, and a share with everyone
 * (About you) always waits. Hobs never write a shared scope themselves: the hub does, as the hob,
 * once the preset or you let it.
 */

/**
 * Where a share stands. `sending` while the hub writes it, `waiting` for your review, `shared` once
 * it is in the shared memory, `kept` when you kept it private (it is in the hob's own memory), and
 * `undone` when you took a share back (it is in the hob's own memory too).
 */
export const MemoryShareState = Schema.Literals(["sending", "waiting", "shared", "kept", "undone"]);
export type MemoryShareState = typeof MemoryShareState.Type;

/** How a share was let through: by your review, or by the preset (Trusting, to a project). */
export const MemoryShareThrough = Schema.Literals(["review", "preset"]);
export type MemoryShareThrough = typeof MemoryShareThrough.Type;

/** A share a hob asked for, recorded and journaled before anything is written. */
export class MemoryShare extends Schema.Class<MemoryShare>("MemoryShare")({
  id: Schema.String,
  agentId: AgentId,
  /** The work the key belongs to, such as `task:<Task id>`: a key is unique within it (#660). */
  work: Schema.String,
  /** The SHA-256 of the key the hob sent, never its text. */
  key: Schema.String,
  /** The SHA-256 of the call's input as stable JSON without its key. */
  input: Schema.String,
  /** The shared memory it is for: a project's or everyone's, never a hob's. */
  scope: MemoryScope,
  path: MemoryPath,
  /** The page, redacted before it was recorded, or as you edited it before you shared it. */
  markdown: Schema.String,
  tags: Schema.Array(Schema.String),
  state: MemoryShareState,
  through: MemoryShareThrough,
  /** Whether you changed the page before you shared it. */
  edited: Schema.Boolean,
  /** The version the share wrote in the shared memory, once shared. */
  version: Schema.NullOr(MemoryVersion),
  /** The version it replaced there, or null when the page was new: what Undo brings back. */
  previous: Schema.NullOr(MemoryVersion),
  /** The reply the call was made from, when it came from a chat turn. */
  threadId: Schema.NullOr(ThreadId),
  messageId: Schema.NullOr(MessageId),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  /** When it was shared, kept private or undone. */
  decidedAt: Schema.NullOr(Schema.String),
}) {}

/** Whether a share waits for you. */
export const memoryShareWaits = (share: MemoryShare): boolean => share.state === "waiting";

/** Where a share goes, in words for the hob. */
const whereOf = (scope: MemoryScope): string =>
  scope._tag === "Project" ? `the project ${scope.identity}` : "every hob (About you)";

/** What a hob is told when its share waits for the user's review. */
export const memoryShareWaitingText = (path: string, scope: MemoryScope) =>
  `Asked the user to share ${path} with ${whereOf(scope)}. It waits for their review in the Inbox, so it is not shared yet. Do not save it again.`;

/** What a hob is told when its share went through under the user's safety settings. */
export const memoryShareSharedText = (path: string, scope: MemoryScope) =>
  `Shared ${path} with ${whereOf(scope)}. The user can see it in Memory and undo it.`;

/** What a hob is told about a share the user kept private. */
export const memoryShareKeptText = (path: string) =>
  `The user kept ${path} private, so it is in your own memory only.`;

/** What a hob is told about a share the user took back. */
export const memoryShareUndoneText = (path: string) =>
  `The user took back sharing ${path}, so it is in your own memory only.`;
