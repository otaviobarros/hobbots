import type { SkillsList } from "@hobbots/api";
import type { SkillId, SkillUpdate } from "@hobbots/domain";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { skillUpdatesQuery } from "../../api/skill-updates.ts";
import { formatAgo } from "../../lib/format.ts";
import { RowList } from "../memory/memory-overview.tsx";
import { MemoryCard } from "../memory/memory-parts.tsx";
import { messages } from "./messages.ts";
import { revsOf, UpdateDetail } from "./skill-update-detail.tsx";
import { scopeLineOf, tagOf, updatesFrom } from "./skill-updates-model.ts";
import type { Say } from "./skills-flash.ts";
import { type HobDirectory, skillsSearchOf, skillTitle } from "./skills-model.ts";
import { SkillChip, SkillsIcon } from "./skills-parts.tsx";
import { PaneNotRead } from "./skills-views.tsx";

const copy = messages.updates;

const row =
  "flex flex-col gap-0.5 bg-card px-3.5 py-2.5 text-start text-inherit no-underline hover:bg-hover aria-[current=page]:bg-hover";

function UpdateRow({
  update,
  list,
  hobs,
  open,
}: {
  update: SkillUpdate;
  list: SkillsList;
  hobs: HobDirectory;
  open: boolean;
}) {
  const tag = tagOf(update);
  const { from, to } = revsOf(update);
  return (
    <li>
      <Link
        to="/skills"
        search={skillsSearchOf({ _tag: "Updates", item: update.skillId })}
        aria-current={open ? "page" : undefined}
        className={row}
      >
        <span className="flex flex-wrap items-center gap-2">
          <span className="flex-1 text-ui font-semibold text-text-strong">{skillTitle(update.name)}</span>
          <SkillChip tone={tag.tone}>{tag.text}</SkillChip>
        </span>
        <span className="text-meta text-label">
          {copy.revs({ from, to, scope: scopeLineOf(update.skillId, list, hobs) })}
        </span>
      </Link>
    </li>
  );
}

/** Every skill is up to date: what Hobbots does, and the way back. */
function UpToDate() {
  return (
    <MemoryCard label={copy.emptyTitle}>
      <span className="flex items-center gap-2 text-body font-semibold text-text-strong">
        <span className="text-mint">
          <SkillsIcon name="git" />
        </span>
        {copy.emptyTitle}
      </span>
      <p className="m-0 text-ui text-text-secondary">{copy.emptyBody}</p>
      <Link to="/skills" search={{}} className="self-start text-ui text-link">
        {copy.back}
      </Link>
    </MemoryCard>
  );
}

/**
 * Skills › Updates (ADR 029, Updates from a source): what the checks of Git sources found, each with
 * its review beside the list. Nothing changes until you update a skill, or turn on Update
 * automatically for it.
 */
export function SkillUpdates({
  item,
  list,
  hobs,
  say,
  now,
}: {
  item: SkillId | null;
  list: SkillsList;
  hobs: HobDirectory;
  say: Say;
  now: Date;
}) {
  const updates = useQuery(skillUpdatesQuery);
  // With none picked, the first stays open after you decide it, so its flash shows with it.
  const [first, setFirst] = useState<SkillId | null>(null);
  if (updates.data === undefined)
    return (
      <PaneNotRead
        failed={updates.isError}
        text={copy.readFailed}
        retry={copy.retry}
        onRetry={() => void updates.refetch()}
      />
    );
  const view = updates.data;
  const open = view.updates.find((one) => one.skillId === (item ?? first)) ?? view.updates[0];
  if (item === null && open !== undefined && first !== open.skillId) setFirst(open.skillId);
  const checked =
    view.checkedAt === null ? copy.neverChecked : copy.lastChecked({ when: formatAgo(view.checkedAt, now) });
  return (
    <div className="flex flex-col gap-4">
      {view.problems.map((problem) => (
        <p key={problem.sourceId + problem.message} className="m-0 rounded-card bg-notice px-4 py-3 text-ui text-text">
          {copy.problem({ where: updatesFrom(problem.sourceId, list), message: problem.message })}
        </p>
      ))}
      {open === undefined ? (
        <div className="flex max-w-[760px] flex-col gap-2">
          <UpToDate />
          <p className="m-0 text-meta text-label">{checked}</p>
        </div>
      ) : (
        <div className="flex flex-wrap items-start gap-5">
          <div className="flex w-[300px] max-w-full flex-none flex-col gap-2">
            <RowList label={copy.listLabel}>
              {view.updates.map((update) => (
                <UpdateRow key={update.skillId} update={update} list={list} hobs={hobs} open={update === open} />
              ))}
            </RowList>
            <p className="m-0 text-meta text-label">{checked}</p>
          </div>
          <UpdateDetail
            key={open.skillId}
            update={open}
            automatic={view.automatic.includes(open.skillId)}
            list={list}
            hobs={hobs}
            say={say}
            now={now}
          />
        </div>
      )}
    </div>
  );
}
