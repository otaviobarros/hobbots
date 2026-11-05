import { type Agent, type AgentId, MemoryPath, type MemoryScope } from "@hobbots/domain";
import { useIsFetching, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  memoryChangesQuery,
  memoryKeys,
  memoryNotAnswering,
  memoryPageQuery,
  memoryPagesQuery,
  memoryScopesQuery,
  memorySearchQuery,
} from "../../api/memory-pages.ts";
import { agentsQuery, archivedAgentsQuery } from "../../api/queries.ts";
import type { HobDirectory, MemoryView } from "./memory-model.ts";

const EVERYONE: MemoryScope = { _tag: "Everyone" };
const NO_HOBS: ReadonlyArray<Agent> = [];
/** The key a page read keeps while no page is open; it is never read. */
const NO_PAGE = MemoryPath.make("none.md");

/** The scope a view reads pages of, if any: the overview peeks at About you. */
const pagesScope = (view: MemoryView): MemoryScope | null => {
  if (view._tag === "Scope") return view.scope;
  if (view._tag === "Overview") return EVERYONE;
  return null;
};

/** The page `view` reads, for a page and its editor. */
const openedPage = (view: MemoryView) =>
  view._tag === "Page" || view._tag === "Edit"
    ? { open: true, scope: view.scope, path: view.path }
    : { open: false, scope: EVERYONE, path: NO_PAGE };

/**
 * Everything the Memory page reads for `view`: the hobs it names, the scopes and their counts,
 * What changed, and the view's own read. Memory not answering in any of them is the outage the
 * page shows; each read keeps what it last loaded.
 */
export const useMemory = (view: MemoryView) => {
  const queryClient = useQueryClient();
  const agents = useQuery(agentsQuery);
  const archived = useQuery(archivedAgentsQuery);
  const overview = useQuery(memoryScopesQuery);
  const changes = useQuery(memoryChangesQuery);
  const scope = pagesScope(view);
  const pages = useQuery({ ...memoryPagesQuery(scope ?? EVERYONE), enabled: scope !== null });
  const opened = openedPage(view);
  const page = useQuery({ ...memoryPageQuery(opened.scope, opened.path), enabled: opened.open });
  const search = useQuery(
    memorySearchQuery(view._tag === "Search" ? view.q : "", view._tag === "Search" ? view.within : null),
  );
  const fetching = useIsFetching({ queryKey: memoryKeys.all }) > 0;

  const active = agents.data ?? NO_HOBS;
  const hobs: HobDirectory = new Map<AgentId, Agent>(
    [...(archived.data ?? NO_HOBS), ...active].map((hob) => [hob.id, hob]),
  );
  const viewRead = opened.open ? page : view._tag === "Search" ? search : scope === null ? changes : pages;
  const offline = [overview, changes, viewRead].some((read) => read.isError && memoryNotAnswering(read.error));

  return {
    active,
    hobs,
    overview,
    changes,
    pages,
    page,
    search,
    offline,
    retrying: offline && fetching,
    /** Reads every memory query again, as Try again does. */
    retry: () => void queryClient.refetchQueries({ queryKey: memoryKeys.all, type: "active" }),
  };
};
