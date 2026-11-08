import type { SkillsList } from "@hobbots/api";
import { type SkillId, type SkillUpdate, skillRevisionLabel } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { skillUpdatesQuery } from "../../api/skill-updates.ts";
import { skillsErrorTag } from "../../api/skills.ts";
import { formatAgo } from "../../lib/format.ts";
import { RowList } from "../memory/memory-overview.tsx";
import { MemoryCard } from "../memory/memory-parts.tsx";
import { messages } from "./messages.ts";
import { DiffLines } from "./skill-diff.tsx";
import { FlagList } from "./skill-flags.tsx";
import { AutoUpdateSwitch, useSkillUpdateWrites } from "./skill-follow.tsx";
import { otherFilesOf, rolloutOf, scopeLineOf, tagOf, updatesFrom, whoGetsIt } from "./skill-updates-model.ts";
import type { Say } from "./skills-flash.ts";
import { type HobDirectory, skillsSearchOf, skillTitle } from "./skills-model.ts";
import { SkillChip, SkillsIcon } from "./skills-parts.tsx";
import { PaneNotRead } from "./skills-views.tsx";

const copy = messages.updates;

const row =
  "flex flex-col gap-0.5 bg-card px-3.5 py-2.5 text-start text-inherit no-underline hover:bg-hover aria-[current=page]:bg-hover";

const revsOf = (update: SkillUpdate) => ({
  from: skillRevisionLabel({ number: update.baseNumber }),
  to: skillRevisionLabel({ number: update.baseNumber + 1 }),
});

/** Why accepting failed, in words: the repository or the skill moved on since the check, or something else. */
const acceptFailure = (error: unknown) => {
  const tag = skillsErrorTag(error);
  if (tag === "SkillScanOutdated") return copy.moved;
  if (tag === "SkillEditStale" || tag === "SkillMissing") return copy.stale;
  return copy.failed;
};

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

/** The files an update adds, removes or changes beside its `SKILL.md`, each with a short note. */
function OtherFiles({ update }: { update: SkillUpdate }) {
  const files = otherFilesOf(update);
  return (
    <section aria-label={copy.otherFiles} className="flex flex-col gap-1.5">
      <h4 className="lbl m-0 text-label">{copy.otherFiles}</h4>
      {files.length === 0 ? (
        <p className="m-0 text-detail text-text-secondary">{copy.noOtherFiles}</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {files.map((file) => (
            <li key={file.path} className="flex items-center gap-2.5 text-detail">
              <span className="min-w-0 flex-1 truncate font-mono text-text-strong">{file.path}</span>
              <span className="text-label">{file.note}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Accept or Not now, each saying what it did. */
function UpdateDecision({ update, list, say }: { update: SkillUpdate; list: SkillsList; say: Say }) {
  const writes = useSkillUpdateWrites();
  const title = skillTitle(update.name);
  const { from, to } = revsOf(update);
  const input = { skillId: update.skillId, hash: update.hash };
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        disabled={writes.busy}
        onClick={() =>
          writes.accept.mutate(input, {
            onSuccess: () => say({ tone: "done", message: copy.accepted({ title, to, from }) }),
            onError: (error) => say({ tone: "failed", message: acceptFailure(error) }),
          })
        }
      >
        {copy.accept({ count: rolloutOf(update.skillId, list).length })}
      </Button>
      <Button
        variant="outline"
        disabled={writes.busy}
        onClick={() =>
          writes.dismiss.mutate(input, {
            onSuccess: () => say({ tone: "done", message: copy.dismissed({ title, rev: from }) }),
            onError: () => say({ tone: "failed", message: copy.failed }),
          })
        }
      >
        {copy.notNow}
      </Button>
    </div>
  );
}

/** One update as you decide it: what it changes, what to look at, then Update or Not now. */
function UpdateDetail({
  update,
  automatic,
  list,
  hobs,
  say,
  now,
}: {
  update: SkillUpdate;
  automatic: boolean;
  list: SkillsList;
  hobs: HobDirectory;
  say: Say;
  now: Date;
}) {
  const title = skillTitle(update.name);
  const { from, to } = revsOf(update);
  const where = updatesFrom(update.sourceId, list);
  return (
    <article aria-label={title} className="flex min-w-0 flex-1 flex-col gap-3.5">
      <header className="flex flex-col gap-1">
        <span className="lbl text-label">{where}</span>
        <h3 className="m-0 text-title text-text-strong">{title}</h3>
        <span className="text-detail text-text-secondary">
          {`${from} → ${to} · ${copy.found({ when: formatAgo(update.foundAt, now) })}`}
        </span>
      </header>
      {update.flags.length > 0 && (
        <div className="flex flex-col gap-1">
          <FlagList revision={update} />
          <p className="m-0 text-detail text-text-secondary">{copy.waitsBody}</p>
        </div>
      )}
      {update.instructions.map((one) => (
        <section
          key={one.path}
          aria-label={one.path}
          className="overflow-hidden rounded-card border border-line-2 bg-card"
        >
          <div className="border-b border-line bg-deep px-3 py-2.5 font-mono text-detail">{one.path}</div>
          <DiffLines before={one.before ?? ""} after={one.after ?? ""} />
        </section>
      ))}
      <OtherFiles update={update} />
      <UpdateDecision key={update.hash} update={update} list={list} say={say} />
      <MemoryCard label={copy.auto}>
        <AutoUpdateSwitch skillId={update.skillId} on={automatic} say={say} />
      </MemoryCard>
      <dl className="m-0 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-detail">
        <dt className="text-label">{copy.facts.who}</dt>
        <dd className="m-0 text-text-strong">{whoGetsIt(update.skillId, list, hobs)}</dd>
        <dt className="text-label">{copy.facts.upstream}</dt>
        <dd className="m-0 break-words text-text-strong">
          {update.commit === null ? where : `${where} · ${update.commit.slice(0, 7)}`}
        </dd>
      </dl>
    </article>
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
