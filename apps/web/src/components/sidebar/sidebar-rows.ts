import type { Actor, Agent, SidebarPlace, Thread, ThreadId, User } from "@hobbots/domain";
import { formatMonthDay, formatTime } from "../../lib/format.ts";
import { messages as copy } from "./messages.ts";

/** A face in a camp's stack: a hob's tile or a person's initials. */
export type Face = { readonly _tag: "hob"; readonly hob: Agent } | { readonly _tag: "person"; readonly person: User };

/** A camp's row: where the hub put it, the thread it shows and the hob whose camp it is. */
export interface CampRow {
  readonly place: SidebarPlace;
  readonly thread: Thread;
  readonly hob: Agent;
  /** The first two members other than you, for a shared camp's stack. */
  readonly faces: ReadonlyArray<Face>;
  /** A hob waits on you in it. */
  readonly needs: boolean;
  /** Replies you have not read. */
  readonly unread: number;
  /** Who wrote the last line, as a shared camp's row names them; null when it can't tell. */
  readonly lastAuthor: string | null;
}

/**
 * How many replies you have not read: the hub's count, kept in step with the unread threads the
 * event stream follows, so a reply that just landed counts and a thread you just read does not.
 */
export const unreadCount = (place: SidebarPlace, unread: ReadonlySet<ThreadId> | undefined): number => {
  if (unread === undefined) return place.unread;
  return unread.has(place.threadId) ? Math.max(place.unread, 1) : 0;
};

/** A direct message's row: every hob you can talk to, with its chat once it has one. */
export interface DirectRow {
  readonly hob: Agent;
  readonly place: SidebarPlace | undefined;
  readonly chat: Thread | undefined;
}

const faceOf =
  (hobs: ReadonlyArray<Agent>, people: ReadonlyArray<User>) =>
  (actor: SidebarPlace["others"][number]): ReadonlyArray<Face> => {
    if (actor.kind === "hob") {
      const hob = hobs.find((each) => each.id === actor.id);
      return hob === undefined ? [] : [{ _tag: "hob", hob }];
    }
    const person = actor.kind === "user" ? people.find((each) => each.id === actor.id) : undefined;
    return person === undefined ? [] : [{ _tag: "person", person }];
  };

/**
 * The name a camp's row gives the author of its last line: You, a hob's name or a person's, from the
 * hobs and people this client already holds. Null for the hub or anyone it does not know yet, so the
 * row shows the line alone rather than an id.
 */
export const authorName = ({
  author,
  you,
  hobs,
  people,
}: {
  readonly author: Actor | null;
  readonly you: User | undefined;
  readonly hobs: ReadonlyArray<Agent>;
  readonly people: ReadonlyArray<User>;
}): string | null => {
  if (author === null) return null;
  if (author.kind === "hob") return hobs.find((each) => each.id === author.id)?.name ?? null;
  if (author.kind !== "user") return null;
  if (author.id === you?.id) return copy.you;
  return people.find((each) => each.id === author.id)?.name ?? null;
};

/**
 * The camps' rows in the hub's order, each joined with its thread and hob. A camp whose thread or
 * hob this client has not loaded yet waits for them, so a row never shows half a camp.
 */
export const campRows = ({
  places,
  threads,
  hobs,
  you,
  people,
  unread,
}: {
  readonly places: ReadonlyArray<SidebarPlace>;
  readonly threads: ReadonlyMap<ThreadId, Thread>;
  readonly hobs: ReadonlyArray<Agent>;
  readonly you: User | undefined;
  readonly people: ReadonlyArray<User>;
  readonly unread: ReadonlySet<ThreadId> | undefined;
}): ReadonlyArray<CampRow> =>
  places.flatMap((place) => {
    const thread = threads.get(place.threadId);
    const hob = hobs.find((each) => each.id === place.agentId);
    if (thread === undefined || hob === undefined) return [];
    return [
      {
        place,
        thread,
        hob,
        faces: place.others.flatMap(faceOf(hobs, people)).slice(0, 2),
        needs: place.needsYou,
        unread: unreadCount(place, unread),
        lastAuthor: authorName({ author: thread.lastAuthor, you, hobs, people }),
      },
    ];
  });

/** Every hob, in the hob list's order, with its direct message where the hub lists one. */
export const directRows = ({
  hobs,
  places,
  threads,
}: {
  readonly hobs: ReadonlyArray<Agent>;
  readonly places: ReadonlyArray<SidebarPlace>;
  readonly threads: ReadonlyMap<ThreadId, Thread>;
}): ReadonlyArray<DirectRow> =>
  hobs.map((hob) => {
    const place = places.find((each) => each.agentId === hob.id);
    return { hob, place, chat: place === undefined ? undefined : threads.get(place.threadId) };
  });

/** A row's time: the time of day for today, else the day. */
export const rowTime = (iso: string, now: Date = new Date(), locale?: string): string => {
  const at = new Date(iso);
  return at.toDateString() === now.toDateString() ? formatTime(iso, locale) : formatMonthDay(at, locale);
};
