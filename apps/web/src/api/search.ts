import { type SearchHit, searchTerms } from "@hobbots/domain";
import { keepPreviousData, queryOptions, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { call } from "./client.ts";

/** How long typing must pause before the hub is asked. */
const DEBOUNCE_MS = 150;

export const searchQuery = (query: string) =>
  queryOptions({
    queryKey: ["search", query] as const,
    queryFn: () => call((c) => c.search.search({ query: { q: query } })),
    // Messages change all the time, so every new search asks the hub again.
    staleTime: 0,
  });

/**
 * Threads whose title or messages match `query`, asked once typing pauses. While the next answer
 * is on its way the previous one stays, so the list does not flicker.
 */
export const useSearch = (query: string) => {
  const [settled, setSettled] = useState(query);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(query), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);
  const trimmed = settled.trim().slice(0, 200);
  const enabled = searchTerms(trimmed).length > 0 && query.trim() !== "";
  const result = useQuery({ ...searchQuery(trimmed), enabled, placeholderData: keepPreviousData });
  const hits: ReadonlyArray<SearchHit> = enabled ? (result.data ?? []) : [];
  const typing = query.trim() !== settled.trim();
  return { hits, pending: typing || (enabled && result.isPending), error: enabled && result.isError };
};
