import type { Agent, AgentId, SearchHit, SnippetPart, ThreadId } from "@hobbots/domain";
import { cn } from "@hobbots/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { agentsQuery } from "../api/queries.ts";
import { useSearch } from "../api/search.ts";
import { matchesHob } from "../lib/crew.ts";
import { formatWhen } from "../lib/time.ts";
import { HobSprite } from "./hob-sprite.tsx";

/** One thing a search found: a hob by its name or role, or a thread by its title or messages. */
export type SearchResult =
  | { readonly kind: "hob"; readonly key: string; readonly hob: Agent }
  | {
      readonly kind: "thread";
      readonly key: string;
      readonly hob: Agent;
      readonly hit: SearchHit;
      /** The newest matching message, which the thread scrolls to when it opens. */
      readonly messageId: string | undefined;
    };

/** Hobs whose name or role matches, then the threads the hub found, most recently active first. */
export const useSearchResults = (query: string) => {
  const agents = useQuery(agentsQuery);
  const search = useSearch(query);
  const hobs = agents.data ?? [];
  const byId = new Map(hobs.map((hob) => [hob.id, hob]));
  const results: Array<SearchResult> = [
    ...hobs
      .filter((hob) => query.trim() !== "" && matchesHob(hob, query))
      .map((hob) => ({
        kind: "hob" as const,
        key: `hob-${hob.id}`,
        hob,
      })),
    ...search.hits.flatMap((hit) => {
      const hob = byId.get(hit.thread.agentId);
      return hob
        ? [{ kind: "thread" as const, key: `thread-${hit.thread.id}`, hob, hit, messageId: hit.matches[0]?.messageId }]
        : [];
    }),
  ];
  return { results, pending: agents.isPending || search.pending, error: agents.isError || search.error };
};

/** Where a result leads: the hob's chat, or the thread at its newest matching message. */
export const resultLink = (result: SearchResult) =>
  result.kind === "hob"
    ? ({ to: "/hobs/$hobId", params: { hobId: result.hob.id } } as const)
    : ({
        to: "/hobs/$hobId/threads/$threadId",
        params: { hobId: result.hob.id as AgentId, threadId: result.hit.thread.id as ThreadId },
        search: { message: result.messageId },
      } as const);

/** A message's words around the match, with the matching words picked out. */
function Snippet({ parts }: { parts: ReadonlyArray<SnippetPart> }) {
  return (
    <>
      {parts.map((part, index) =>
        part.match ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: the parts never reorder.
          <mark key={index} className="bg-transparent font-bold text-moonlight">
            {part.text}
          </mark>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: the parts never reorder.
          <span key={index}>{part.text}</span>
        ),
      )}
    </>
  );
}

/** A result's second line: the hob's role, or who owns the thread and what matched. */
export function ResultDetail({ result }: { result: SearchResult }) {
  if (result.kind === "hob") return <>{result.hob.roleTitle}</>;
  const match = result.hit.matches[0];
  const more = result.hit.matchCount > 1 ? ` · ${result.hit.matchCount} matches` : "";
  return (
    <>
      {result.hob.name} · {match ? <Snippet parts={match.snippet} /> : formatWhen(result.hit.thread.updatedAt)}
      {more}
    </>
  );
}

/** The hob panel's search results, in place of the hob list while a search is typed. */
export function SearchResults({ query, onOpen }: { query: string; onOpen: () => void }) {
  const { results, pending, error } = useSearchResults(query);
  const count = results.length === 1 ? "1 result" : `${results.length} results`;

  return (
    <div className="flex min-h-0 flex-col gap-0.5 overflow-y-auto">
      <span role="status" className="lbl px-2 pb-1.5 text-label">
        {pending && results.length === 0 ? "Searching…" : count}
      </span>
      {error && <p className="px-2 text-sm text-rose">Could not search. Try again.</p>}
      {results.map((result) => (
        <Link
          key={result.key}
          {...resultLink(result)}
          onClick={onOpen}
          className={cn(
            "hop-on-hover cut flex w-full animate-hb-in items-start gap-2.5 px-2 py-[7px] text-text no-underline",
            "hover:bg-hover hover:text-text",
          )}
        >
          <span className="mt-0.5 flex-none">
            <HobSprite hob={result.hob} size={22} state={result.hob.status === "paused" ? "paused" : "idle"} />
          </span>
          <span className="flex min-w-0 flex-col gap-px">
            <span className="text-sm font-bold">
              {result.kind === "hob" ? result.hob.name : result.hit.thread.title}
            </span>
            <span className="line-clamp-2 text-xs text-secondary-text">
              <ResultDetail result={result} />
            </span>
          </span>
        </Link>
      ))}
      {!pending && !error && results.length === 0 && (
        <p className="m-0 px-2 text-sm text-secondary-text">Nothing matches “{query.trim()}”.</p>
      )}
    </div>
  );
}
