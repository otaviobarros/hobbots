import type { SkillDetail } from "@hobbots/api";
import {
  type AgentId,
  SKILL_FEEDBACK_SUGGESTS_REVISION,
  type SkillFeedback,
  type SkillId,
  type SkillUseCounts,
  skillRevisionLabel,
  type Thread,
  type ThreadId,
} from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { Skeleton } from "@hobbots/ui/components/skeleton";
import { useQueries, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { threadsQuery } from "../../api/queries.ts";
import { skillFeedbackQuery, skillUsesQuery } from "../../api/skills.ts";
import { formatWhen } from "../../lib/time.ts";
import { RowList } from "../memory/memory-overview.tsx";
import { messages } from "./messages.ts";
import { type HobDirectory, skillTitle, usedRevision } from "./skills-model.ts";
import { ScopeMark } from "./skills-parts.tsx";

const copy = messages.activity;

/** The titles of the chats the hobs in `agentIds` have, read once per hob. */
const useThreadTitles = (agentIds: ReadonlyArray<AgentId>) => {
  const reads = useQueries({ queries: agentIds.map((agentId) => threadsQuery(agentId)) });
  const titles = new Map<ThreadId, string>();
  for (const read of reads)
    for (const thread of (read.data ?? []) as ReadonlyArray<Thread>) titles.set(thread.id, thread.title);
  return titles;
};

type SkillUses = typeof SkillUseCounts.Type;

/** A hob's uses of the skill, with when it last used it. */
function HobUseRow({ use, hobs }: { use: SkillUses["hobs"][number]; hobs: HobDirectory }) {
  const hob = hobs.get(use.agentId);
  return (
    <li className="flex items-center gap-2.5 bg-card px-3.5 py-2.5">
      <ScopeMark scope={{ _tag: "Hob", agentId: use.agentId }} hob={hob} />
      <span className="min-w-0 flex-1 truncate text-ui text-text-strong">{hob?.name ?? messages.scopes.formerHob}</span>
      <span className="text-meta whitespace-nowrap text-label">
        {copy.times({ count: use.count, when: formatWhen(use.lastAt) })}
      </span>
    </li>
  );
}

/** A chat the skill was used in, which opens the chat. */
function ChatUseRow({
  use,
  hobs,
  title,
}: {
  use: SkillUses["threads"][number];
  hobs: HobDirectory;
  title: string | undefined;
}) {
  const hob = hobs.get(use.agentId)?.name ?? messages.scopes.formerHob;
  return (
    <li className="[contain-intrinsic-size:auto_44px] [content-visibility:auto]">
      <Link
        to="/hobs/$hobId/threads/$threadId"
        params={{ hobId: use.agentId, threadId: use.threadId }}
        className="flex items-center gap-3 bg-card px-3.5 py-2.5 text-inherit no-underline hover:bg-hover"
      >
        <span className="min-w-0 flex-1 truncate text-ui text-text-strong">
          {copy.chatLine({ hob, chat: title ?? copy.chat })}
        </span>
        <span className="text-meta whitespace-nowrap text-label">
          {copy.times({ count: use.count, when: formatWhen(use.lastAt) })}
        </span>
      </Link>
    </li>
  );
}

/** A read that failed, with Try again. */
function ReadFailed({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <p role="alert" className="m-0 flex items-center gap-3 rounded-card bg-notice px-4 py-3 text-ui text-text">
      <span className="flex-1">{message}</span>
      <Button variant="outline" size="xs" onClick={onRetry}>
        {copy.retry}
      </Button>
    </p>
  );
}

/**
 * The notes hobs left that the skill is wrong, outdated or unclear, newest first, each saying how many
 * more would suggest a revision (ADR 029, `skill_feedback`). Nothing shows until a hob leaves one.
 */
function SkillNotes({ skillId, hobs }: { skillId: SkillId; hobs: HobDirectory }) {
  const read = useQuery(skillFeedbackQuery(skillId));
  if (read.data === undefined) {
    return read.isError ? (
      <ReadFailed message={copy.notesFailed} onRetry={() => void read.refetch()} />
    ) : (
      <div aria-busy="true" className="flex flex-col gap-2">
        <Skeleton width="30ch" />
      </div>
    );
  }
  const notes: ReadonlyArray<SkillFeedback> = read.data;
  if (notes.length === 0) return null;
  const more = Math.max(0, SKILL_FEEDBACK_SUGGESTS_REVISION - notes.length);
  return (
    <section aria-label={copy.notes} className="flex flex-col gap-1">
      <h3 className="lbl m-0 pb-1 text-label">
        {copy.notes} <span className="tabular-nums">{notes.length}</span>
      </h3>
      <RowList label={copy.notes}>
        {notes.map((one) => (
          <li key={one.id} className="flex flex-col gap-0.5 bg-card px-3.5 py-2.5">
            <span className="text-ui text-text-strong">{copy.note({ note: one.note })}</span>
            <span className="text-meta text-label">
              {copy.noteBy({
                hob: hobs.get(one.agentId)?.name ?? messages.scopes.formerHob,
                kind: copy.noteKind[one.kind],
                when: formatWhen(one.createdAt),
                more,
              })}
            </span>
          </li>
        ))}
      </RowList>
    </section>
  );
}

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
          {copy.line({ name: title, rev: skillRevisionLabel({ number: usedRevision(detail) }) })}
        </p>
      </section>
      {uses.data === undefined ? (
        uses.isError ? (
          <ReadFailed message={copy.failed} onRetry={() => void uses.refetch()} />
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
              {uses.data.hobs.map((one) => (
                <HobUseRow key={one.agentId} use={one} hobs={hobs} />
              ))}
            </RowList>
          </section>
          <section aria-label={copy.chats} className="flex flex-col gap-1">
            <h3 className="lbl m-0 pb-1 text-label">{copy.chats}</h3>
            <RowList label={copy.chats}>
              {uses.data.threads.map((one) => (
                <ChatUseRow key={one.threadId} use={one} hobs={hobs} title={titles.get(one.threadId)} />
              ))}
            </RowList>
          </section>
        </>
      )}
      <SkillNotes skillId={skill.id} hobs={hobs} />
    </div>
  );
}
