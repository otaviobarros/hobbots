import type { Agent, Thread } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "@hobbots/ui/components/empty";
import { SearchField } from "@hobbots/ui/components/search-field";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import type { ActivityMap } from "../../api/activity.ts";
import { inboxQuery } from "../../api/approvals.ts";
import { agentsQuery, archivedThreadsQuery } from "../../api/queries.ts";
import { useQuestWork } from "../../api/quest-work.ts";
import { useSearch } from "../../api/search.ts";
import { questsInProgress } from "../../lib/quest-work.ts";
import { ChatRow } from "./chat-row.tsx";
import { chatGroups, chatMatches, OLDER_SHOWN, questsByThread, waitingByThread } from "./chats-model.ts";
import { messages } from "./messages.ts";

const copy = messages.chats;

/**
 * The Chats tab: the hob's chats grouped Pinned, Today, Earlier this week and Older, five Older at
 * first. Search finds words in titles and inside messages, and marks them; a link can open it
 * already searching.
 */
export function HobChats({
  hob,
  threads,
  activity,
  initialQuery = "",
}: {
  hob: Agent;
  threads: ReadonlyArray<Thread>;
  activity: ActivityMap;
  initialQuery?: string;
}) {
  const [query, setQuery] = useState(initialQuery);
  const [allOlder, setAllOlder] = useState(false);
  const search = useSearch(query);
  const waiting = useQuery({ ...inboxQuery, select: waitingByThread }).data;
  const searching = query.trim() !== "";
  const hobs = useQuery(agentsQuery).data ?? [];
  const quests = questsByThread(questsInProgress(useQuestWork(hobs.map((each) => each.id))));

  const row = (thread: Thread, match?: Pick<Parameters<typeof ChatRow>[0], "title" | "snippet">) => (
    <ChatRow
      key={thread.id}
      hob={hob}
      thread={thread}
      live={activity[thread.id] !== undefined}
      needs={waiting?.get(thread.id) ?? 0}
      quests={quests.get(thread.id) ?? []}
      {...match}
    />
  );

  return (
    <div className="flex flex-col gap-3.5">
      <div className="flex justify-end">
        <SearchField
          value={query}
          onValueChange={setQuery}
          clearLabel={copy.search.clear}
          aria-label={copy.search.label({ name: hob.name })}
          placeholder={copy.search.placeholder}
          className="w-[300px] max-w-full"
        />
      </div>
      {searching ? (
        <Matches hob={hob} query={query} onClear={() => setQuery("")} search={search} threads={threads} row={row} />
      ) : (
        chatGroups(threads, new Date()).map(({ group, threads: list }) => {
          const hidden = group === "older" && !allOlder ? Math.max(0, list.length - OLDER_SHOWN) : 0;
          return (
            <Group key={group} label={copy.groups[group]}>
              {list.slice(0, list.length - hidden).map((thread) => row(thread))}
              {hidden > 0 && <ShowMore onClick={() => setAllOlder(true)}>{copy.showOlder({ count: hidden })}</ShowMore>}
            </Group>
          );
        })
      )}
      <ArchivedLink hob={hob} />
    </div>
  );
}

function Matches({
  hob,
  query,
  onClear,
  search,
  threads,
  row,
}: {
  hob: Agent;
  query: string;
  onClear: () => void;
  search: ReturnType<typeof useSearch>;
  threads: ReadonlyArray<Thread>;
  row: (thread: Thread, match: { title: ChatMatchParts; snippet: ChatMatchParts | null }) => ReactNode;
}) {
  const matches = chatMatches(threads, search.hits, query);
  if (matches.length > 0)
    return <Group label={copy.groups.matches}>{matches.map((match) => row(match.thread, match))}</Group>;
  if (search.error)
    return (
      <p role="alert" className="m-0 text-sm text-rose">
        {copy.search.failed}
      </p>
    );
  if (search.pending)
    return (
      <p role="status" className="m-0 text-sm text-label">
        {copy.search.searching}
      </p>
    );
  return (
    <Empty surface="card">
      <EmptyHeader>
        <EmptyTitle>{copy.search.none({ name: hob.name, query: query.trim() })}</EmptyTitle>
        <EmptyDescription>{copy.search.archivedHint}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button variant="outline" onClick={onClear}>
          {copy.search.clearButton}
        </Button>
      </EmptyContent>
    </Empty>
  );
}

type ChatMatchParts = ReturnType<typeof chatMatches>[number]["title"];

/** A group of chats: its label on a rule, then one card of rows. */
function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section aria-label={label} className="flex flex-col">
      <h3 className="lbl m-0 flex items-center gap-2 px-1 pb-1.5 text-xs leading-4 text-label after:h-px after:flex-1 after:bg-line">
        {label}
      </h3>
      <ul className="cut m-0 flex list-none flex-col overflow-hidden bg-card p-0">{children}</ul>
    </section>
  );
}

function ShowMore({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <li className="border-t border-line">
      <button
        type="button"
        onClick={onClick}
        className="w-full cursor-pointer bg-transparent px-3.5 py-2.5 text-left text-sm text-link underline decoration-line-2 underline-offset-3 hover:bg-hover"
      >
        {children}
      </button>
    </li>
  );
}

/** Archived chats · N, which opens the Archive narrowed to this hob; hidden while there are none. */
function ArchivedLink({ hob }: { hob: Agent }) {
  const count = useQuery({ ...archivedThreadsQuery(hob.id), select: (list) => list.length }).data ?? 0;
  if (count === 0) return null;
  return (
    <Link
      to="/archive"
      search={{ hob: hob.id }}
      className="inline-flex items-center gap-2 self-start rounded-control px-2 py-1.5 text-sm text-text-secondary no-underline hover:bg-hover hover:text-text-strong"
    >
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        className="size-4"
      >
        <rect x="2" y="3" width="12" height="3" rx="1" />
        <path d="M3 6v7h10V6M6.5 9h3" />
      </svg>
      {copy.archived({ count })}
      <span aria-hidden>→</span>
    </Link>
  );
}
