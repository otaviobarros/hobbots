import { type Agent, type AgentId, foldWord, searchTerms, type Thread, type ThreadId } from "@hobbots/domain";

/** The Archive's two tabs. */
const ARCHIVE_TABS = ["chats", "hobs"] as const;
export type ArchiveTab = (typeof ARCHIVE_TABS)[number];

export const isArchiveTab = (value: unknown): value is ArchiveTab => ARCHIVE_TABS.some((tab) => tab === value);

/** How many archived chats show before Show N more. */
export const SHOWN = 12;

type HobLike = Pick<Agent, "id" | "name">;
type ThreadLike = Pick<Thread, "id" | "title" | "archivedAt">;

/** An archived chat with the hob it belongs to. */
export interface ArchivedChat<H extends HobLike = Agent, T extends ThreadLike = Thread> {
  readonly hob: H;
  readonly thread: T;
}

/** Every hob's archived chats in one list, most recently archived first. */
export const allArchivedChats = <H extends HobLike, T extends ThreadLike>(
  hobs: ReadonlyArray<H>,
  archived: ReadonlyMap<AgentId, ReadonlyArray<T>>,
): ReadonlyArray<ArchivedChat<H, T>> =>
  hobs
    .flatMap((hob) => (archived.get(hob.id) ?? []).map((thread) => ({ hob, thread })))
    .sort((a, b) => (b.thread.archivedAt ?? "").localeCompare(a.thread.archivedAt ?? ""));

/**
 * The hobs the scope offers: each hob with archived chats, by name, and the hob the Archive was
 * opened for even when it has none, so its empty list can say so.
 */
export const scopeHobs = <H extends HobLike>(
  hobs: ReadonlyArray<H>,
  chats: ReadonlyArray<ArchivedChat<HobLike, ThreadLike>>,
  chosen: AgentId | undefined,
): ReadonlyArray<H> => {
  const withChats = new Set(chats.map((chat) => chat.hob.id));
  return hobs.filter((hob) => withChats.has(hob.id) || hob.id === chosen).sort((a, b) => a.name.localeCompare(b.name));
};

/**
 * The chats one hob's scope or All hobs shows, narrowed by the search: a chat matches when its title
 * holds every word of the query, or the hub's search found the words in its messages.
 */
export const visibleChats = <C extends ArchivedChat<HobLike, ThreadLike>>(
  chats: ReadonlyArray<C>,
  hobId: AgentId | undefined,
  query: string,
  messageHits: ReadonlySet<ThreadId>,
): ReadonlyArray<C> => {
  const terms = searchTerms(query);
  return chats.filter((chat) => {
    if (hobId !== undefined && chat.hob.id !== hobId) return false;
    if (terms.length === 0) return true;
    if (messageHits.has(chat.thread.id)) return true;
    const title = foldWord(chat.thread.title);
    return terms.every((term) => title.includes(term));
  });
};
