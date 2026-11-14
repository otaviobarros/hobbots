import { Schema } from "effect";
import { Actor, sameActor } from "./actor.ts";
import { AgentId, ThreadId } from "./ids.ts";
import type { Thread } from "./thread.ts";
import type { ThreadMember } from "./thread-member.ts";

/**
 * The sidebar's sections (ADR 039, The sidebar): Camps, with the camps you share first and then the
 * camps a hob runs alone with you, and Direct messages. Which one a thread is in follows from its kind
 * and its members each time the hub reads it; it is never stored.
 */
export const SidebarSection = Schema.Literals(["shared-camp", "hob-camp", "direct-message"]);
export type SidebarSection = typeof SidebarSection.Type;

/** One thread's row in the sidebar, for the person asking. */
export class SidebarPlace extends Schema.Class<SidebarPlace>("SidebarPlace")({
  threadId: ThreadId,
  /** The hob the thread belongs to: a direct message's hob, or the hob whose camp it is. */
  agentId: AgentId,
  section: SidebarSection,
  /** Its active members other than you, hobs and people, in the order they joined. */
  others: Schema.Array(Actor),
  /** Replies you have not read. */
  unread: Schema.Number,
  /** Mentions of you that you have not read. */
  mentions: Schema.Number,
}) {}

/** Your camps, shared ones first, and your direct messages, as the hub sorted them. */
export class Sidebar extends Schema.Class<Sidebar>("Sidebar")({
  camps: Schema.Array(SidebarPlace),
  directMessages: Schema.Array(SidebarPlace),
}) {}

/**
 * Which section a thread is in for `you`, from its kind and its members: a chat is a direct message;
 * a camp with more than one other member, or with another person, is shared; any other camp is the
 * hob's own.
 */
export const sidebarSectionOf = (
  thread: Pick<Thread, "kind">,
  members: ReadonlyArray<Pick<ThreadMember, "actor" | "state">>,
  you: Actor,
): SidebarSection => {
  if (thread.kind === "chat") return "direct-message";
  const others = members.filter((member) => member.state === "active" && !sameActor(member.actor, you));
  return others.length > 1 || others.some((member) => member.actor.kind === "user") ? "shared-camp" : "hob-camp";
};

/** What the hub knows about one thread when it sorts the sidebar. */
export interface SidebarThread {
  readonly thread: Pick<Thread, "id" | "agentId" | "kind" | "state" | "pinnedAt" | "updatedAt">;
  /** The thread's members in every state. */
  readonly members: ReadonlyArray<Pick<ThreadMember, "actor" | "state">>;
  readonly unread: number;
  readonly mentions: number;
}

const CAMP_ORDER: Record<SidebarSection, number> = { "shared-camp": 0, "hob-camp": 1, "direct-message": 2 };

/** Pinned first, the most recently pinned on top, then by last activity, newest first. */
const byPinThenActivity = (a: SidebarThread["thread"], b: SidebarThread["thread"]) => {
  if ((a.pinnedAt === null) !== (b.pinnedAt === null)) return a.pinnedAt === null ? 1 : -1;
  return (
    (b.pinnedAt ?? "").localeCompare(a.pinnedAt ?? "") ||
    b.updatedAt.localeCompare(a.updatedAt) ||
    a.id.localeCompare(b.id)
  );
};

/**
 * The sidebar for `you` (ADR 039, The sidebar): every open thread you are an active member of, each
 * in the section its members put it in. Camps list the shared ones first, then the hobs' own, each
 * pinned first and then by last activity. Direct messages keep the order of `threads`, which the hub
 * gives hob by hob, oldest hob first, so a hob keeps its place.
 */
export const sidebarOf = ({
  you,
  threads,
}: {
  readonly you: Actor;
  readonly threads: ReadonlyArray<SidebarThread>;
}): Sidebar => {
  const places = threads
    .filter(
      ({ thread, members }) =>
        thread.state === "open" && members.some((member) => member.state === "active" && sameActor(member.actor, you)),
    )
    .map((each) => ({
      each,
      place: new SidebarPlace({
        threadId: each.thread.id,
        agentId: each.thread.agentId,
        section: sidebarSectionOf(each.thread, each.members, you),
        others: each.members
          .filter((member) => member.state === "active" && !sameActor(member.actor, you))
          .map((member) => member.actor),
        unread: each.unread,
        mentions: each.mentions,
      }),
    }));
  const camps = places
    .filter(({ place }) => place.section !== "direct-message")
    .sort(
      (a, b) =>
        CAMP_ORDER[a.place.section] - CAMP_ORDER[b.place.section] || byPinThenActivity(a.each.thread, b.each.thread),
    );
  return new Sidebar({
    camps: camps.map(({ place }) => place),
    directMessages: places.filter(({ place }) => place.section === "direct-message").map(({ place }) => place),
  });
};
