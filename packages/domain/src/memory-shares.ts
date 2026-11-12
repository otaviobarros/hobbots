import { Schema } from "effect";
import { defineMachine } from "./machine.ts";
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

/**
 * What can happen to a share. `Share` and `Keep` are your decisions on a share that waits, `Undo`
 * takes a shared one back: each records what the hub is about to write, before it writes it.
 * `Restored` is an Undo past its first step. `Shared`, `Kept` and `Undone` are what landed in memory,
 * and `Conflicted` a write a change in memory stopped, which sends the share back.
 */
export type MemoryShareEvent =
  | {
      readonly _tag: "Share";
      /** The page as it is shared: as the hob wrote it, or as you edited it. */
      readonly markdown: string;
      readonly edited: boolean;
      /** The shared page's version and text the share replaces, or null when it is new. */
      readonly previous: MemoryVersion | null;
      readonly replaced: string | null;
      readonly at: string;
    }
  | { readonly _tag: "Keep"; readonly at: string }
  | { readonly _tag: "Undo"; readonly at: string }
  | { readonly _tag: "Restored"; readonly at: string }
  | { readonly _tag: "Shared"; readonly version: MemoryVersion; readonly at: string }
  | { readonly _tag: "Kept"; readonly at: string }
  | { readonly _tag: "Undone"; readonly at: string }
  | { readonly _tag: "Conflicted"; readonly at: string };

/** A change to a share its state does not allow. */
export class IllegalMemoryShareTransition extends Schema.TaggedError<IllegalMemoryShareTransition>()(
  "IllegalMemoryShareTransition",
  { shareId: Schema.String, from: MemoryShareState, pending: Schema.NullOr(MemorySharePending), to: MemoryShareState },
) {}

const pendingIs =
  (...pending: ReadonlyArray<MemorySharePending>) =>
  (share: MemoryShare) =>
    share.pending !== null && pending.includes(share.pending);

/** The share after an event, with what changed. */
const next = (share: MemoryShare, at: string, fields: Partial<MemoryShare>) =>
  new MemoryShare({ ...share, ...fields, updatedAt: at });

/**
 * A share's lifecycle (ADR 028, Sharing), declared once. `pending` says what a `sending` share is
 * writing and is null in every other state. A share or keep cut short by a change in memory waits for
 * you again; an Undo cut short stays shared; an Undo past its first step only has the hob's own copy
 * left to write, so it never goes back.
 */
export const MemoryShareMachine = defineMachine<
  MemoryShareState,
  MemoryShareEvent,
  MemoryShare,
  IllegalMemoryShareTransition
>({
  name: "MemoryShare",
  states: {
    waiting: "It waits for your review in the Inbox; nothing is written",
    sending: "The hub is writing what `pending` records, and finishes it after a restart or an outage",
    shared: "It is in the shared memory, and you can undo it",
    kept: "You kept it private: it is in the hob's own memory only",
    undone: "You took it back: the shared page is as it was, and the hob keeps the page itself",
  },
  field: "state",
  events: {
    Share: {
      from: ["waiting"],
      to: "sending",
      apply: (share, e) =>
        next(share, e.at, {
          state: "sending",
          pending: "share",
          markdown: e.markdown,
          edited: e.edited,
          previous: e.previous,
          replaced: e.replaced,
        }),
    },
    Keep: {
      from: ["waiting"],
      to: "sending",
      apply: (share, e) => next(share, e.at, { state: "sending", pending: "keep" }),
    },
    Undo: {
      from: ["shared"],
      to: "sending",
      apply: (share, e) => next(share, e.at, { state: "sending", pending: "undo" }),
    },
    Restored: {
      from: ["sending"],
      to: "sending",
      guard: pendingIs("undo"),
      apply: (share, e) => next(share, e.at, { pending: "restored" }),
    },
    Shared: {
      from: ["sending"],
      to: "shared",
      guard: pendingIs("share"),
      apply: (share, e) => next(share, e.at, { state: "shared", pending: null, version: e.version, decidedAt: e.at }),
    },
    Kept: {
      from: ["sending"],
      to: "kept",
      guard: pendingIs("keep"),
      apply: (share, e) => next(share, e.at, { state: "kept", pending: null, decidedAt: e.at }),
    },
    Undone: {
      from: ["sending"],
      to: "undone",
      guard: pendingIs("restored"),
      apply: (share, e) => next(share, e.at, { state: "undone", pending: null, decidedAt: e.at }),
    },
    Conflicted: [
      {
        from: ["sending"],
        to: "shared",
        guard: pendingIs("undo"),
        apply: (share, e) => next(share, e.at, { state: "shared", pending: null }),
      },
      {
        from: ["sending"],
        to: "waiting",
        guard: pendingIs("share", "keep"),
        apply: (share, e) =>
          next(share, e.at, {
            state: "waiting",
            pending: null,
            through: "review",
            version: null,
            previous: null,
            replaced: null,
          }),
      },
    ],
  },
  illegal: (share, _, to) =>
    new IllegalMemoryShareTransition({ shareId: share.id, from: share.state, pending: share.pending, to }),
});

/** Whether a share waits for you. */
export const memoryShareWaits = (share: Pick<MemoryShare, "state">): boolean => share.state === "waiting";

/** `MemoryShareMachine` with the questions code outside this module asks of a share's state. */
export const MemoryShareStates = {
  ...MemoryShareMachine,
  /** Whether a share waits for you. */
  waits: memoryShareWaits,
  /** Whether a share is in the shared memory, so you can undo it. */
  isShared: (share: Pick<MemoryShare, "state">): boolean => share.state === "shared",
  /** Whether the hub is writing a share, which recovery finishes when no call is writing it. */
  isSending: (share: Pick<MemoryShare, "state">): boolean => share.state === "sending",
  /** What the hob that asked for a share is told, by where the share stands. */
  answerText: (share: MemoryShare): string => {
    switch (share.state) {
      case "sending":
        return share.through === "preset"
          ? memoryShareSendingText(share.path, share.scope)
          : memoryShareWaitingText(share.path, share.scope);
      case "waiting":
        return memoryShareWaitingText(share.path, share.scope);
      case "shared":
        return memoryShareSharedText(share.path, share.scope);
      case "kept":
        return memoryShareKeptText(share.path);
      case "undone":
        return memoryShareUndoneText(share.path);
    }
  },
};

/** Where a share goes, in words for the hob. */
const whereOf = (scope: MemoryScope): string =>
  scope._tag === "Project" ? `the project ${scope.identity}` : "every hob (About you)";

/** What a hob is told when its share waits for the user's review. */
const memoryShareWaitingText = (path: string, scope: MemoryScope) =>
  `Asked the user to share ${path} with ${whereOf(scope)}. It waits for their review in the Inbox, so it is not shared yet. Do not save it again.`;

/** What a hob is told when its share goes through under the user's safety settings once memory answers. */
const memoryShareSendingText = (path: string, scope: MemoryScope) =>
  `Memory is not answering right now, so Hobbots shares ${path} with ${whereOf(scope)} once it is back. Do not save it again.`;

/** What a hob is told when its share went through under the user's safety settings. */
const memoryShareSharedText = (path: string, scope: MemoryScope) =>
  `Shared ${path} with ${whereOf(scope)}. The user can see it in Memory and undo it.`;

/** What a hob is told about a share the user kept private. */
const memoryShareKeptText = (path: string) => `The user kept ${path} private, so it is in your own memory only.`;

/** What a hob is told about a share the user took back. */
const memoryShareUndoneText = (path: string) => `The user took back sharing ${path}, so it is in your own memory only.`;
