import { FIND_QUERY_MAX, type FindResult, type ThreadId } from "@hobbots/domain";
import { keepPreviousData, queryOptions, useMutation, useQuery } from "@tanstack/react-query";
import { call } from "./client.ts";
import { useSettledQuery } from "./search.ts";

// Find (ADR 037, #1386): the decisions, artifacts, chapters and messages with every word typed, in
// one chat or camp or everywhere, and Ask, which answers a question from the records with sources.

/** How often open results are read again: about as often as the hub indexes what changed. */
const REFRESH_MS = 5_000;

const findQuery = (query: string, scope: ThreadId | null) =>
  queryOptions({
    queryKey: ["find", scope, query] as const,
    queryFn: () => call((c) => c.search.find({ query: scope === null ? { q: query } : { q: query, in: scope } })),
    // Records and messages change all the time, so every new search asks the hub again. The hub
    // indexes a new record within seconds of it, so results that stay open are read again too.
    staleTime: 0,
    refetchInterval: REFRESH_MS,
  });

const nothing: FindResult = { records: [], messages: [] };

/**
 * What matches `query` in the chat or camp `scope`, or everywhere when it is null, asked once
 * typing pauses. While the next answer is on its way the previous one stays, so nothing flickers.
 */
export const useFind = (query: string, scope: ThreadId | null) => {
  const { trimmed, enabled, typing } = useSettledQuery(query);
  const result = useQuery({ ...findQuery(trimmed, scope), enabled, placeholderData: keepPreviousData });
  const found = enabled ? (result.data ?? nothing) : nothing;
  return { found, pending: typing || (enabled && result.isPending), error: enabled && result.isError };
};

/** The key every Ask shares, so another view can tell one is running. */
const askKey = ["find", "ask"] as const;

/** Ask: the hub's brain's answer from the records that match a question, with the records it cites. */
export const useAsk = () =>
  useMutation({
    mutationKey: askKey,
    mutationFn: (input: { readonly question: string; readonly scope: ThreadId | null }) =>
      call((c) =>
        c.search.ask({ payload: { question: input.question.trim().slice(0, FIND_QUERY_MAX), in: input.scope } }),
      ),
  });
