import type { ChannelArchived } from "@hobbots/api";
import type { Actor, Committed, MemberRefused, ChannelId, ChannelMember } from "@hobbots/domain";
import { Context, type Effect, type Option } from "effect";

/**
 * Who is in each direct message and camp (ADR 039, Members). A channel is stored with its first two
 * members, the person who made it and its hob, journaled with it, and a hob leaves every channel
 * when it retires and comes back when it returns; this reads them and adds more.
 */
export class ChannelMemberRepository extends Context.Service<
  ChannelMemberRepository,
  {
    /** The channel's members in every state: the owner first, then in the order they joined. */
    readonly list: (channelId: ChannelId) => Effect.Effect<ReadonlyArray<ChannelMember>>;
    readonly find: (channelId: ChannelId, actor: Actor) => Effect.Effect<Option.Option<ChannelMember>>;
    /**
     * Adds `actor` to the channel as an active member, added by `addedBy`, journaled as
     * `ChannelMemberAdded`; one who left or was removed comes back, journaled as `ChannelMemberChanged`.
     * Nothing is journaled for a member already active. A direct message takes no one but its person
     * and its hob: `MemberRefused`. Dies when the channel does not exist. `asMember`: `addedBy` must
     * be an active member when the change is written, or it is refused `not-member`, and the
     * channel must not be archived by then: `ChannelArchived`.
     */
    readonly add: (
      channelId: ChannelId,
      actor: Actor,
      addedBy: Actor,
      asMember?: boolean,
    ) => Effect.Effect<Committed<ChannelMember>, MemberRefused | ChannelArchived>;
    /**
     * The mentions of `actor` they have not read, per channel they are an active member of (ADR 039,
     * Users as actors): a count for each channel with any. Pass the session's actor, so each person
     * sees their own. Their own messages, notes to self and a lead's quiet progress never count.
     */
    readonly unreadMentions: (
      actor: Actor,
    ) => Effect.Effect<ReadonlyArray<{ readonly channelId: ChannelId; readonly count: number }>>;
    /**
     * The replies `actor` has not read, per channel they are an active member of (ADR 039, read markers
     * per member): a count for each channel with any, counted as the unread channels are.
     */
    readonly unreadReplies: (
      actor: Actor,
    ) => Effect.Effect<ReadonlyArray<{ readonly channelId: ChannelId; readonly count: number }>>;
  }
>()("@hobbots/agents/ChannelMemberRepository") {}
