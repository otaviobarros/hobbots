import { Schema } from "effect";
import { Actor, sameActor } from "./actor.ts";
import { ChannelId } from "./ids.ts";
import { defineMachine } from "./machine.ts";
import { Revision } from "./revision.ts";
import type { Channel } from "./channel.ts";

/**
 * Who is in a direct message or a camp (ADR 039, Members): a person or a hob, each one row per channel.
 * Every channel has two from the start, the person who made it and its hob. A direct message keeps
 * exactly those two; a camp takes more.
 */

/** `owner` for the person whose channel it is, `member` for everyone else, hobs included. */
export const MemberRole = Schema.Literals(["owner", "member"]);
export type MemberRole = typeof MemberRole.Type;

/** Where a member stands, held by `MemberMachine`. */
export const MemberState = Schema.Literals(["active", "left", "removed"]);
export type MemberState = typeof MemberState.Type;

export class ChannelMember extends Schema.Class<ChannelMember>("ChannelMember")({
  channelId: ChannelId,
  /** A person (`user`) or a hob; one row per channel and actor. */
  actor: Actor,
  role: MemberRole,
  /** Only `MemberMachine` changes it, and code outside reads it through `ChannelMembers`. */
  state: MemberState,
  joinedAt: Schema.String,
  /** Who added the member: the person who made the channel, for its first two. */
  addedBy: Actor,
  /**
   * How far this member read the channel: the revision of the newest message they saw, or null before
   * they read any. A hob's stays null. Unread counts, the unread line and catch-up read the member
   * row of the person asking (ADR 039, read markers per member).
   */
  readRevision: Schema.NullOr(Schema.Number),
  /** Until when the member muted the channel, or null. A muted channel still counts mentions of them. */
  mutedUntil: Schema.NullOr(Schema.String),
  revision: Revision,
}) {}

/**
 * The channels unread for the person asking (ADR 039, read markers per member): those where a hob
 * wrote since their own read marker, as the hub works it out. `through` is the newest journal
 * sequence the read could see, so a reply that lands after it is unread whatever the list says.
 */
export class UnreadChannels extends Schema.Class<UnreadChannels>("UnreadChannels")({
  channelIds: Schema.Array(ChannelId),
  through: Schema.Number,
}) {}

/** What can happen to a member. */
export type MemberEvent =
  /** Leaves on their own, as a hob does when it retires. */
  | { readonly _tag: "Leave" }
  /** Another member took them out. */
  | { readonly _tag: "Remove" }
  /** Back in the channel, as a hob is when it comes back from retirement. */
  | { readonly _tag: "Return" };

/** A change to a member its state does not allow. */
export class IllegalMemberTransition extends Schema.TaggedError<IllegalMemberTransition>()("IllegalMemberTransition", {
  channelId: ChannelId,
  actor: Actor,
  from: MemberState,
  to: MemberState,
}) {}

/**
 * A member's lifecycle (ADR 039, Members), declared once. A person or hob added by a member is
 * active at once; an invited state comes with accounts.
 */
export const MemberMachine = defineMachine<MemberState, MemberEvent, ChannelMember, IllegalMemberTransition>({
  name: "Member",
  states: {
    active: "In the channel: reads it, is counted among its members and can be mentioned",
    left: "Left on their own, as a retired hob does; comes back with Return",
    removed: "Taken out by another member; only adding them again brings them back",
  },
  field: "state",
  events: {
    Leave: {
      from: ["active"],
      to: "left",
      apply: (member) => new ChannelMember({ ...member, state: "left" }),
    },
    Remove: {
      from: ["active"],
      to: "removed",
      apply: (member) => new ChannelMember({ ...member, state: "removed" }),
    },
    Return: {
      from: ["left", "removed"],
      to: "active",
      apply: (member) => new ChannelMember({ ...member, state: "active" }),
    },
  },
  illegal: (member, _event, to) =>
    new IllegalMemberTransition({ channelId: member.channelId, actor: member.actor, from: member.state, to }),
});

/**
 * Why a member cannot be added or removed. `direct-message`: a direct message keeps exactly its person
 * and its hob. `lead`: the hob a camp was made with leads its quests and stays. `owner`: the person
 * whose camp it is stays. `not-member`: they are not in the channel, or the person asking is not.
 * `unknown`: the hub has no such person.
 */
/**
 * Why a member change was refused. `leads-quest`: the hob leads a Quest still open in the camp, whose
 * results and answers come back there, so it stays until that Quest ends.
 */
export const MemberRefusal = Schema.Literals([
  "direct-message",
  "lead",
  "owner",
  "not-member",
  "unknown",
  "leads-quest",
]);
export type MemberRefusal = typeof MemberRefusal.Type;

/** A member a channel refused to add. */
export class MemberRefused extends Schema.TaggedError<MemberRefused>()("MemberRefused", {
  channelId: ChannelId,
  actor: Actor,
  reason: MemberRefusal,
}) {}

/**
 * What adding `actor` to a channel does, given its members in every state: `add` a new row, `return`
 * the one that left or was removed, keep one already `active`, or refuse. A direct message (a chat)
 * takes no one but the two it started with, so only they can come back to it.
 */
export const planMemberAdd = (
  channel: Pick<Channel, "kind">,
  members: ReadonlyArray<ChannelMember>,
  actor: Actor,
):
  | { readonly _tag: "add" }
  | { readonly _tag: "return"; readonly member: ChannelMember }
  | { readonly _tag: "active"; readonly member: ChannelMember }
  | { readonly _tag: "refused"; readonly reason: MemberRefusal } => {
  const member = members.find((each) => sameActor(each.actor, actor));
  if (member !== undefined) {
    return member.state === "active" ? { _tag: "active", member } : { _tag: "return", member };
  }
  return channel.kind === "direct" ? { _tag: "refused", reason: "direct-message" } : { _tag: "add" };
};

/**
 * What removing `actor` from a channel does, given its members in every state: `remove` the active
 * member, keep one who already `left` or was removed, or refuse. A direct message keeps its two, a
 * camp keeps its owner and the hob it was made with, which leads its quests (ADR 039, Members).
 */
export const planMemberRemove = (
  channel: Pick<Channel, "kind" | "ownerHobId">,
  members: ReadonlyArray<ChannelMember>,
  actor: Actor,
):
  | { readonly _tag: "remove"; readonly member: ChannelMember }
  | { readonly _tag: "gone"; readonly member: ChannelMember }
  | { readonly _tag: "refused"; readonly reason: MemberRefusal } => {
  if (channel.kind === "direct") return { _tag: "refused", reason: "direct-message" };
  const member = members.find((each) => sameActor(each.actor, actor));
  if (member === undefined) return { _tag: "refused", reason: "not-member" };
  if (member.role === "owner") return { _tag: "refused", reason: "owner" };
  if (actor.kind === "hob" && actor.id === channel.ownerHobId) return { _tag: "refused", reason: "lead" };
  return member.state === "active" ? { _tag: "remove", member } : { _tag: "gone", member };
};

/** Whether `actor` is an active member among `members`: the one who may change who is in a camp. */
export const isActiveMember = (members: ReadonlyArray<ChannelMember>, actor: Actor): boolean =>
  members.some((member) => member.state === "active" && sameActor(member.actor, actor));

/** `MemberMachine` with the questions code outside this module asks of a member's state. */
export const ChannelMembers = {
  ...MemberMachine,
  isActive: (member: ChannelMember): boolean => member.state === "active",
  /** Whether the member is this actor. */
  is: (member: ChannelMember, actor: Actor): boolean => sameActor(member.actor, actor),
};
