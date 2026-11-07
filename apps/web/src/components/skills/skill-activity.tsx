import type { SkillDetail } from "@hobbots/api";
import { type AgentId, skillRevisionLabel, type Thread, type ThreadId } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { Skeleton } from "@hobbots/ui/components/skeleton";
import { useQueries, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { threadsQuery } from "../../api/queries.ts";
import { skillUsesQuery } from "../../api/skills.ts";
import { formatWhen } from "../../lib/time.ts";
import { RowList } from "../memory/memory-overview.tsx";
import { messages } from "./messages.ts";
import { type HobDirectory, skillTitle } from "./skills-model.ts";
import { ScopeMark } from "./skills-parts.tsx";

const copy = messages.activity;

/** The titles of the chats the hobs in `agentIds` have, read once per hob. */
const useThreadTitles = (agentIds: ReadonlyArray<AgentId>) => {
  const reads = useQueries({ queries: agentIds.map((agentId) => threadsQuery(agentId)) });
  const titles = new Map<ThreadId, string>();
  for (const read of reads) for (const thread of (read.data ?? []) as ReadonlyArray<Thread>) titles.set(thread.id, thread.title);
  return titles;
};

/**
 * A skill's Activity (ADR 029, The use line): how the use line reads under a reply, how often hobs
 * used it, and each chat it was used in, the most recent first.
 */
export function SkillActivity({ detail, hobs }: { detail: SkillDetail; hobs: HobDirectory }) {
  const { skill } = detail;
  const uses = useQuery(skillUsesQuery(skill.id));
  const titles = useThreadTitles(uses.data?.hobs.map((one) => one.agentId) ?? []);
  const title = skillTitle(skill.name);

  return (
    <div className="flex max-w-[760px] flex-col gap-4.5">
      <section aria-label={copy.shows} className="flex flex-col gap-1.5 rounded-card bg-card p-4">
        <h3 className="lbl m-0 text-label">{copy.shows}</h3>
        <p className="m-0 text-detail text-text-secondary">
          {copy.line({ name: title, rev: skillRevisionLabel({ number: skill.revisions }) })}
        </p>
      </section>
      {uses.data === undefined ? (
        uses.isError ? (
          <p role="alert" className="m-0 flex items-center gap-3 rounded-card bg-notice px-4 py-3 text-ui text-text">
            <span className="flex-1">{copy.failed}</span>
            <Button variant="outline" size="xs" onClick={() => void uses.refetch()}>
              {copy.retry}
            </Button>
          </p>
        ) : (
          <div aria-busy="true" className="flex flex-col gap-2">
            <Skeleton width="40ch" />
            <Skeleton width="60%" />
          </div>
        )
      ) : uses.data.total === 0 ? (
        <p className="m-0 text-ui text-text-secondary">{copy.never}</p>
      ) : (
        <>
          <p className="m-0 text-ui text-text-strong">
            {copy.summary({ total: uses.data.total, week: uses.data.thisWeek, hobs: uses.data.hobs.length })}
          </p>
          <section aria-label={copy.byHob} className="flex flex-col gap-1">
            <h3 className="lbl m-0 pb-1 text-label">{copy.byHob}</h3>
            <RowList label={copy.byHob}>
              {uses.data.hobs.map((one) => {
                const hob = hobs.get(one.agentId);
                return (
                  <li key={one.agentId} className="flex items-center gap-2.5 bg-card px-3.5 py-2.5">
                    <ScopeMark scope={{ _tag: "Hob", agentId: one.agentId }} hob={hob} />
                    <span className="min-w-0 flex-1 truncate text-ui text-text-strong">
                      {hob?.name ?? messages.scopes.formerHob}
                    </span>
                    <span className="text-meta whitespace-nowrap text-label">
                      {copy.times({ count: one.count, when: formatWhen(one.lastAt) })}
                    </span>
                  </li>
                );
              })}
            </RowList>
          </section>
          <section aria-label={copy.chats} className="flex flex-col gap-1">
            <h3 className="lbl m-0 pb-1 text-label">{copy.chats}</h3>
            <RowList label={copy.chats}>
              {uses.data.threads.map((one) => {
                const hob = hobs.get(one.agentId)?.name ?? messages.scopes.formerHob;
                const chat = titles.get(one.threadId) ?? copy.chat;
                return (
                  <li key={one.threadId} className="[contain-intrinsic-size:auto_44px] [content-visibility:auto]">
                    <Link
                      to="/hobs/$hobId/threads/$threadId"
                      params={{ hobId: one.agentId, threadId: one.threadId }}
                      className="flex items-center gap-3 bg-card px-3.5 py-2.5 text-inherit no-underline hover:bg-hover"
                    >
                      <span className="min-w-0 flex-1 truncate text-ui text-text-strong">
                        {copy.chatLine({ hob, chat })}
                      </span>
                      <span className="text-meta whitespace-nowrap text-label">
                        {copy.times({ count: one.count, when: formatWhen(one.lastAt) })}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </RowList>
          </section>
        </>
      )}
    </div>
  );
}
