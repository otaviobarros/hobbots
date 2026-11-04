import type { Agent, AgentId, SearchHit, SnippetPart, ThreadId } from "@hobbots/domain";
import { Badge } from "@hobbots/ui/components/badge";
import { cn } from "@hobbots/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { agentsQuery } from "../api/queries.ts";
import { useSearch } from "../api/search.ts";
import { matchesHob } from "../lib/crew.ts";
import { formatWhen } from "../lib/time.ts";
import { messages as archivedCopy } from "./archived-threads/messages.ts";
import { HobSprite } from "./hob-sprite.tsx";
import { messages } from "./messages.ts";

const copy = messages.search;

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

/** Where a result leads: the hob's page, or the thread at its newest matching message. */
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

/** Marks a thread result that is archived; it opens read-only, with Restore. */
export function ArchivedTag({ result }: { result: SearchResult }) {
  if (result.kind !== "thread" || result.hit.thread.archivedAt === null) return null;
  return <Badge variant="archived">{archivedCopy.tag}</Badge>;
}

/** A result's second line: the hob's role, or who owns the thread and what matched. */
export function ResultDetail({ result }: { result: SearchResult }) {
  if (result.kind === "hob") return <>{result.hob.roleTitle}</>;
  const match = result.hit.matches[0];
  const more = result.hit.matchCount > 1 ? ` · ${copy.matches({ count: result.hit.matchCount })}` : "";
  return (
    <>
      {result.hob.name} · {match ? <Snippet parts={match.snippet} /> : formatWhen(result.hit.thread.updatedAt)}
      {more}
    </>
  );
}
