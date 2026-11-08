import type { SkillsList } from "@hobbots/api";
import { type SkillUpdate, skillRevisionLabel } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { useState } from "react";
import { skillsErrorTag } from "../../api/skills.ts";
import { formatAgo } from "../../lib/format.ts";
import { MemoryCard } from "../memory/memory-parts.tsx";
import { messages } from "./messages.ts";
import { DiffLines } from "./skill-diff.tsx";
import { FlagList } from "./skill-flags.tsx";
import { AutoUpdateSwitch, useSkillUpdateWrites } from "./skill-follow.tsx";
import { otherFilesOf, rolloutOf, updatesFrom, whoGetsIt } from "./skill-updates-model.ts";
import type { Say } from "./skills-flash.ts";
import { type HobDirectory, skillTitle } from "./skills-model.ts";

const copy = messages.updates;

/** The revision an update moves from, and the one accepting it adds. */
export const revsOf = (update: SkillUpdate) => ({
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

/**
 * Accept or Not now, each saying what it did. The line is said from the mutation's own promise, not
 * its per-call callbacks: the event the change publishes can take this update off the page before the
 * answer arrives, and callbacks of an unmounted observer never run.
 */
function UpdateDecision({ update, list, say }: { update: SkillUpdate; list: SkillsList; say: Say }) {
  const writes = useSkillUpdateWrites();
  const title = skillTitle(update.name);
  const { from, to } = revsOf(update);
  const input = { skillId: update.skillId, hash: update.hash };
  // A review that leaves part of a SKILL.md out cannot show every change: you say you read it first.
  const cut = update.instructions.some((one) => one.cut);
  const [read, setRead] = useState(false);
  return (
    <div className="flex flex-col gap-2">
      {cut && (
        <label className="flex items-start gap-2.5 text-ui text-text-strong">
          <input
            type="checkbox"
            className="mt-1 size-4 flex-none accent-(--color-mint-deep)"
            checked={read}
            onChange={(event) => setRead(event.target.checked)}
          />
          {copy.readWhole}
        </label>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          disabled={writes.busy || (cut && !read)}
          onClick={() =>
            void writes.accept.mutateAsync({ ...input, base: update.base }).then(
              () => say({ tone: "done", message: copy.accepted({ title, to, from }) }),
              (error: unknown) => say({ tone: "failed", message: acceptFailure(error) }),
            )
          }
        >
          {copy.accept({ count: rolloutOf(update.skillId, list).length })}
        </Button>
        <Button
          variant="outline"
          disabled={writes.busy}
          onClick={() =>
            void writes.dismiss.mutateAsync(input).then(
              () => say({ tone: "done", message: copy.dismissed({ title, rev: from }) }),
              () => say({ tone: "failed", message: copy.failed }),
            )
          }
        >
          {copy.notNow}
        </Button>
      </div>
    </div>
  );
}

/** One update as you decide it: what it changes, what to look at, then Update or Not now. */
export function UpdateDetail({
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
          {one.cut && (
            <p role="note" className="m-0 border-b border-line bg-notice px-3 py-2.5 text-detail text-text">
              {copy.cut({ where: update.commit === null ? where : `${where} · ${update.commit.slice(0, 7)}` })}
            </p>
          )}
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
