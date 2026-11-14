import { Schema } from "effect";
import { Actor, sameActor } from "./actor.ts";
import { ThreadId } from "./ids.ts";
import { defineMachine } from "./machine.ts";
import { Revision } from "./revision.ts";
import type { Thread } from "./thread.ts";

/**
 * Who is in a direct message or a camp (ADR 039, Members): a person or a hob, each one row per thread.
 * Every thread has two from the start, the person who made it and its hob. A direct message keeps
 * exactly those two; a camp takes more.
 */

/** `owner` for the person whose thread it is, `member` for everyone else, hobs included. */
export const MemberRole = Schema.Literals(["owner", "member"]);
export type MemberRole = typeof MemberRole.Type;

/** Where a member stands, held by `MemberMachine`. */
export const MemberState = Schema.Literals(["active", "left", "removed"]);
export type MemberState = typeof MemberState.Type;

export class ThreadMember extends Schema.Class<ThreadMember>("ThreadMember")({
  threadId: ThreadId,
  /** A person (`user`) or a hob; one row per thread and actor. */
  actor: Actor,
  role: MemberRole,
  /** Only `MemberMachine` changes it, and code outside reads it through `ThreadMembers`. */
  state: MemberState,
  joinedAt: Schema.String,
  /** Who added the member: the person who made the thread, for its first two. */
  addedBy: Actor,
  /**
   * How far this member read the thread: the revision of the newest message they saw, or null before
   * they read any. A hob's stays null. Unread counts, the unread line and catch-up read the member
   * row of the person asking (ADR 039, read markers per member).
   */
  readRevision: Schema.NullOr(Schema.Number),
  /** Until when the member muted the thread, or null. A muted thread still counts mentions of them. */
  mutedUntil: Schema.NullOr(Schema.String),
  revision: Revision,
}) {}

/**
 * The threads unread for the person asking (ADR 039, read markers per member): those where a hob
 * wrote since their own read marker, as the hub works it out. `through` is the newest journal
 * sequence the read could see, so a reply that lands after it is unread whatever the list says.
 */
export class UnreadThreads extends Schema.Class<UnreadThreads>("UnreadThreads")({
  threadIds: Schema.Array(ThreadId),
  through: Schema.Number,
}) {}

/** What can happen to a member. */
export type MemberEvent =
  /** Leaves on their own, as a hob does when it retires. */
  | { readonly _tag: "Leave" }
  /** Another member took them out. */
  | { readonly _tag: "Remove" }
  /** Back in the thread, as a hob is when it comes back from retirement. */
  | { readonly _tag: "Return" };

/** A change to a member its state does not allow. */
export class IllegalMemberTransition extends Schema.TaggedError<IllegalMemberTransition>()("IllegalMemberTransition", {
  threadId: ThreadId,
  actor: Actor,
  from: MemberState,
  to: MemberState,
}) {}

/**
 * A member's lifecycle (ADR 039, Members), declared once. A person or hob added by a member is
 * active at once; an invited state comes with accounts.
 */
export const MemberMachine = defineMachine<MemberState, MemberEvent, ThreadMember, IllegalMemberTransition>({
  name: "Member",
  states: {
    active: "In the thread: reads it, is counted among its members and can be mentioned",
    left: "Left on their own, as a retired hob does; comes back with Return",
    removed: "Taken out by another member; only adding them again brings them back",
  },
  field: "state",
  events: {
    Leave: {
      from: ["active"],
      to: "left",
      apply: (member) => new ThreadMember({ ...member, state: "left" }),
    },
    Remove: {
      from: ["active"],
      to: "removed",
      apply: (member) => new ThreadMember({ ...member, state: "removed" }),
    },
    Return: {
      from: ["left", "removed"],
      to: "active",
      apply: (member) => new ThreadMember({ ...member, state: "active" }),
    },
  },
  illegal: (member, _event, to) =>
    new IllegalMemberTransition({ threadId: member.threadId, actor: member.actor, from: member.state, to }),
});

/** Why a member cannot be added. `direct-message`: a direct message keeps exactly its person and its hob. */
export const MemberRefusal = Schema.Literals(["direct-message"]);
export type MemberRefusal = typeof MemberRefusal.Type;

/** A member a thread refused to add. */
export class MemberRefused extends Schema.TaggedError<MemberRefused>()("MemberRefused", {
  threadId: ThreadId,
  actor: Actor,
  reason: MemberRefusal,
}) {}

/**
 * What adding `actor` to a thread does, given its members in every state: `add` a new row, `return`
 * the one that left or was removed, keep one already `active`, or refuse. A direct message (a chat)
 * takes no one but the two it started with, so only they can come back to it.
 */
export const planMemberAdd = (
  thread: Pick<Thread, "kind">,
  members: ReadonlyArray<ThreadMember>,
  actor: Actor,
):
  | { readonly _tag: "add" }
  | { readonly _tag: "return"; readonly member: ThreadMember }
  | { readonly _tag: "active"; readonly member: ThreadMember }
  | { readonly _tag: "refused"; readonly reason: MemberRefusal } => {
  const member = members.find((each) => sameActor(each.actor, actor));
  if (member !== undefined) {
    return member.state === "active" ? { _tag: "active", member } : { _tag: "return", member };
  }
  return thread.kind === "chat" ? { _tag: "refused", reason: "direct-message" } : { _tag: "add" };
};

/** `MemberMachine` with the questions code outside this module asks of a member's state. */
export const ThreadMembers = {
  ...MemberMachine,
  isActive: (member: ThreadMember): boolean => member.state === "active",
  /** Whether the member is this actor. */
  is: (member: ThreadMember, actor: Actor): boolean => sameActor(member.actor, actor),
};
