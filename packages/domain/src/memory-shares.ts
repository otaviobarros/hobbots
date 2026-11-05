import { Schema } from "effect";
import { MemoryScope, MemoryVersion } from "./memory.ts";
import { MEMORY_CALL_FIELDS, MEMORY_CALL_ORIGIN } from "./memory-tools.ts";

/**
 * Shares (ADR 028, Sharing): a `memory_save` that asks to put a page beyond the hob's own memory,
 * into a project's or everyone's. The safety preset decides it: under Careful and Balanced it waits
 * for your review, under Trusting a share to a project goes through, and a share with everyone
 * (About you) always waits. Hobs never write a shared scope themselves: the hub does, as the hob,
 * once the preset or you let it.
 */

/**
 * Where a share stands. `sending` while the hub writes what was decided (`pending` says what),
 * `waiting` for your review, `shared` once it is in the shared memory, `kept` when you kept it
 * private (it is in the hob's own memory), and `undone` when you took a share back (it is in the
 * hob's own memory too).
 */
export const MemoryShareState = Schema.Literals(["sending", "waiting", "shared", "kept", "undone"]);
export type MemoryShareState = typeof MemoryShareState.Type;

/**
 * What the hub is writing for a share while it is `sending`, recorded before memory is touched so a
 * hub that stopped, or memory that stopped answering, finds out afterwards what landed: sharing it,
 * keeping it private, or undoing it. `restored` is an Undo past its first step: the shared memory is
 * back as it was, and only the hob's own copy is left to write.
 */
export const MemorySharePending = Schema.Literals(["share", "keep", "undo", "restored"]);
export type MemorySharePending = typeof MemorySharePending.Type;

/** How a share was let through: by your review, or by the preset (Trusting, to a project). */
export const MemoryShareThrough = Schema.Literals(["review", "preset"]);
export type MemoryShareThrough = typeof MemoryShareThrough.Type;

/** A share a hob asked for, recorded and journaled before anything is written. */
export class MemoryShare extends Schema.Class<MemoryShare>("MemoryShare")({
  ...MEMORY_CALL_FIELDS,
  /** The shared memory it is for: a project's or everyone's, never a hob's. */
  scope: MemoryScope,
  state: MemoryShareState,
  /** What is being written while the share is `sending`, otherwise null. */
  pending: Schema.NullOr(MemorySharePending),
  through: MemoryShareThrough,
  /** Whether you changed the page before you shared it. */
  edited: Schema.Boolean,
  /** The version the share wrote in the shared memory, once shared. */
  version: Schema.NullOr(MemoryVersion),
  /**
   * The version it replaced there, or null when the page was new: what Undo brings back. Recorded
   * before the share is written, so a write that landed unrecorded is found after it.
   */
  previous: Schema.NullOr(MemoryVersion),
  /**
   * The page `previous` holds, as it was, recorded with it. Memory names no author for an older
   * version, so the hub knows its own write, or its own Undo, by what that version changed.
   */
  replaced: Schema.NullOr(Schema.String),
  ...MEMORY_CALL_ORIGIN,
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

/** What a hob is told when its share goes through under the user's safety settings once memory answers. */
export const memoryShareSendingText = (path: string, scope: MemoryScope) =>
  `Memory is not answering right now, so Hobbots shares ${path} with ${whereOf(scope)} once it is back. Do not save it again.`;

/** What a hob is told when its share went through under the user's safety settings. */
export const memoryShareSharedText = (path: string, scope: MemoryScope) =>
  `Shared ${path} with ${whereOf(scope)}. The user can see it in Memory and undo it.`;

/** What a hob is told about a share the user kept private. */
export const memoryShareKeptText = (path: string) => `The user kept ${path} private, so it is in your own memory only.`;

/** What a hob is told about a share the user took back. */
export const memoryShareUndoneText = (path: string) =>
  `The user took back sharing ${path}, so it is in your own memory only.`;
