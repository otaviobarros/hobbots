import { type Agent, type AgentId, foldWord, searchTerms, type Thread, type ThreadId } from "@hobbots/domain";
import { Schema } from "effect";

/** The Archive's two tabs. */
const ARCHIVE_TABS = ["chats", "hobs"] as const;
export const ArchiveTab = Schema.Literals(ARCHIVE_TABS);
export type ArchiveTab = typeof ArchiveTab.Type;

export const isArchiveTab = Schema.is(ArchiveTab);

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

/** How many hob chips the scope shows before the rest go under More hobs. */
const SCOPE_CHIPS = 6;

export interface ScopeChip<H> {
  readonly hob: H;
  readonly count: number;
}

/**
 * The scope's hob chips: the six hobs with the most archived chats (ties by name), then More hobs
 * with the rest by name. A hob picked from More hobs joins the chips, so the picked one always shows.
 */
export const scopeChips = <H extends HobLike>(
  hobs: ReadonlyArray<H>,
  chats: ReadonlyArray<ArchivedChat<HobLike, ThreadLike>>,
  chosen: AgentId | undefined,
): { readonly chips: ReadonlyArray<ScopeChip<H>>; readonly more: ReadonlyArray<ScopeChip<H>> } => {
  const counts = new Map<AgentId, number>();
  for (const chat of chats) counts.set(chat.hob.id, (counts.get(chat.hob.id) ?? 0) + 1);
  const ranked = hobs
    .filter((hob) => counts.has(hob.id) || hob.id === chosen)
    .map((hob) => ({ hob, count: counts.get(hob.id) ?? 0 }))
    .sort((a, b) => b.count - a.count || a.hob.name.localeCompare(b.hob.name));
  const chips = ranked.slice(0, SCOPE_CHIPS);
  const rest = ranked.slice(SCOPE_CHIPS).sort((a, b) => a.hob.name.localeCompare(b.hob.name));
  const picked = rest.find((chip) => chip.hob.id === chosen);
  return picked ? { chips: [...chips, picked], more: rest.filter((chip) => chip !== picked) } : { chips, more: rest };
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
