import { Schema } from "effect";
import { Actor, sameActor } from "./actor.ts";
import { AgentId, ChannelId } from "./ids.ts";
import type { Channel } from "./channel.ts";
import type { ChannelMember } from "./channel-member.ts";

/**
 * The sidebar's sections (ADR 039, The sidebar): Camps, with the camps you share first and then the
 * camps a hob runs alone with you, and Direct messages. Which one a channel is in follows from its kind
 * and its members each time the hub reads it; it is never stored.
 */
export const SidebarSection = Schema.Literals(["shared-camp", "hob-camp", "direct-message"]);
export type SidebarSection = typeof SidebarSection.Type;

/** One channel's row in the sidebar, for the person asking. */
export class SidebarPlace extends Schema.Class<SidebarPlace>("SidebarPlace")({
  channelId: ChannelId,
  /** The hob the channel belongs to: a direct message's hob, or the hob whose camp it is. */
  agentId: AgentId,
  section: SidebarSection,
  /** Its active members other than you, hobs and people, in the order they joined. */
  others: Schema.Array(Actor),
  /** Replies you have not read. */
  unread: Schema.Number,
  /** Mentions of you that you have not read. */
  mentions: Schema.Number,
  /** Something there waits on you: an approval, a question, a blocker or failed work. */
  needsYou: Schema.Boolean,
}) {}

/** Your camps, shared ones first, and your direct messages, as the hub sorted them. */
export class Sidebar extends Schema.Class<Sidebar>("Sidebar")({
  camps: Schema.Array(SidebarPlace),
  directMessages: Schema.Array(SidebarPlace),
}) {}

/**
 * Which section a channel is in for `you`, from its kind and its members: a chat is a direct message;
 * a camp with more than one other member, or with another person, is shared; any other camp is the
 * hob's own.
 */
export const sidebarSectionOf = (
  channel: Pick<Channel, "kind">,
  members: ReadonlyArray<Pick<ChannelMember, "actor" | "state">>,
  you: Actor,
): SidebarSection => {
  if (channel.kind === "direct") return "direct-message";
  const others = members.filter((member) => member.state === "active" && !sameActor(member.actor, you));
  return others.length > 1 || others.some((member) => member.actor.kind === "user") ? "shared-camp" : "hob-camp";
};

/** What the hub knows about one channel when it sorts the sidebar. */
export interface SidebarChannel {
  readonly channel: Pick<Channel, "id" | "ownerHobId" | "kind" | "state" | "pinnedAt" | "updatedAt">;
  /** The channel's members in every state. */
  readonly members: ReadonlyArray<Pick<ChannelMember, "actor" | "state">>;
  readonly unread: number;
  readonly mentions: number;
  readonly needsYou: boolean;
}

const CAMP_ORDER: Record<SidebarSection, number> = { "shared-camp": 0, "hob-camp": 1, "direct-message": 2 };

/** Pinned first, the most recently pinned on top, then by last activity, newest first. */
const byPinThenActivity = (a: SidebarChannel["channel"], b: SidebarChannel["channel"]) => {
  if ((a.pinnedAt === null) !== (b.pinnedAt === null)) return a.pinnedAt === null ? 1 : -1;
  return (
    (b.pinnedAt ?? "").localeCompare(a.pinnedAt ?? "") ||
    b.updatedAt.localeCompare(a.updatedAt) ||
    a.id.localeCompare(b.id)
  );
};

/**
 * The sidebar for `you` (ADR 039, The sidebar): every open channel you are an active member of, each
 * in the section its members put it in. Camps list the shared ones first, then the hobs' own, each
 * pinned first and then by last activity. Direct messages keep the order of `channels`, which the hub
 * gives hob by hob, oldest hob first, so a hob keeps its place.
 */
export const sidebarOf = ({
  you,
  channels,
}: {
  readonly you: Actor;
  readonly channels: ReadonlyArray<SidebarChannel>;
}): Sidebar => {
  const places = channels
    .filter(
      ({ channel, members }) =>
        channel.state === "open" && members.some((member) => member.state === "active" && sameActor(member.actor, you)),
    )
    .map((each) => ({
      each,
      place: new SidebarPlace({
        channelId: each.channel.id,
        agentId: each.channel.ownerHobId,
        section: sidebarSectionOf(each.channel, each.members, you),
        others: each.members
          .filter((member) => member.state === "active" && !sameActor(member.actor, you))
          .map((member) => member.actor),
        unread: each.unread,
        mentions: each.mentions,
        needsYou: each.needsYou,
      }),
    }));
  const camps = places
    .filter(({ place }) => place.section !== "direct-message")
    .sort(
      (a, b) =>
        CAMP_ORDER[a.place.section] - CAMP_ORDER[b.place.section] || byPinThenActivity(a.each.channel, b.each.channel),
    );
  return new Sidebar({
    camps: camps.map(({ place }) => place),
    directMessages: places.filter(({ place }) => place.section === "direct-message").map(({ place }) => place),
  });
};
