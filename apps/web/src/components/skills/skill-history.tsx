import type { SkillDetail } from "@hobbots/api";
import { type SkillRevision, skillRevisionLabel } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { Skeleton } from "@hobbots/ui/components/skeleton";
import { cn } from "@hobbots/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { diffLines } from "diff";
import { skillRevisionQuery } from "../../api/skills.ts";
import { formatDay } from "../../lib/format.ts";
import { messages } from "./messages.ts";
import type { Say } from "./skills-flash.ts";
import { fileChanges, type SkillsView, skillsSearchOf } from "./skills-model.ts";
import { useSkillWrites } from "./use-skill-writes.ts";

const copy = messages;

type SkillViewOf = Extract<SkillsView, { _tag: "Skill" }>;

const whatOf = (revision: SkillRevision) => {
  switch (revision.addedBy._tag) {
    case "You":
      return copy.history.byYou;
    case "Hob":
      return copy.history.byHob;
    case "Source":
      return copy.history.bySource;
  }
};

const metaOf = (revision: SkillRevision) =>
  copy.history.meta({
    when: formatDay(revision.addedAt),
    extra: [
      ...(revision.commit === null ? [] : [copy.history.commit({ commit: revision.commit.slice(0, 7) })]),
      ...(revision.label === null ? [] : [revision.label]),
      ...(revision.flags.length === 0 ? [] : [copy.history.flagged]),
    ],
  });

/** The lines of two SKILL.md texts, each marked as added, removed or the same. */
const linesOf = (before: string, after: string) =>
  diffLines(before, after).flatMap((part) =>
    part.value
      .replace(/\n$/, "")
      .split("\n")
      .map((text) => ({ op: part.added ? "add" : part.removed ? "remove" : "same", text }) as const),
  );

/** What one revision changed against the one before it: its SKILL.md line by line, and how many other files moved. */
function RevisionChanges({
  detail,
  revision,
  previous,
}: {
  detail: SkillDetail;
  revision: SkillRevision;
  previous: SkillRevision;
}) {
  const after = useQuery(skillRevisionQuery(detail.skill.id, revision.hash));
  const before = useQuery(skillRevisionQuery(detail.skill.id, previous.hash));
  const label = copy.history.changesOf({ from: skillRevisionLabel(previous), to: skillRevisionLabel(revision) });
  const files = fileChanges(revision, previous);
  return (
    <section aria-label={label} className="overflow-hidden rounded-card border border-line-2 bg-card">
      <div className="flex items-center gap-2 border-b border-line bg-deep px-3 py-2.5 text-detail">
        <span className="flex-1">{label}</span>
        <span className="text-label">{copy.history.filesChanged(files)}</span>
      </div>
      {(after.isError || before.isError) && (
        <p className="m-0 px-3 py-2 text-ui text-text-secondary">{copy.history.failed}</p>
      )}
      {(after.isPending || before.isPending) && (
        <div role="status" className="flex flex-col gap-2 px-3 py-2">
          <span className="sr-only">{copy.history.loading}</span>
          <Skeleton surface="card" width="60%" />
        </div>
      )}
      {after.isSuccess && before.isSuccess && (
        <ul className="m-0 list-none p-0 py-1">
          {linesOf(before.data.instructions, after.data.instructions).map((line, at) => (
            <li
              // biome-ignore lint/suspicious/noArrayIndexKey: a diff's lines have no identity but their place (STD-REACT-020).
              key={at}
              className={cn(
                "flex gap-2.5 px-3 py-1 font-mono text-detail",
                line.op === "add" && "bg-[color-mix(in_srgb,var(--color-mint)_12%,transparent)] text-text-strong",
                line.op === "remove" &&
                  "bg-[color-mix(in_srgb,var(--color-rose)_10%,transparent)] text-text-secondary line-through",
                line.op === "same" && "text-text-secondary",
              )}
            >
              <span aria-hidden className={cn("w-2.5 flex-none", line.op === "add" ? "text-mint" : "text-rose")}>
                {line.op === "add" ? "+" : line.op === "remove" ? "−" : " "}
              </span>
              <span className="sr-only">
                {line.op === "add"
                  ? `${copy.history.added}: `
                  : line.op === "remove"
                    ? `${copy.history.removed}: `
                    : ""}
              </span>
              <span className="min-w-0 break-words whitespace-pre-wrap">{line.text}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** History: every revision, newest first, with Changes and Roll back to an older one. */
export function SkillHistory({ view, detail, say }: { view: SkillViewOf; detail: SkillDetail; say: Say }) {
  const writes = useSkillWrites();
  const { revisions, skill } = detail;
  const shownAt = revisions.findIndex((revision) => revision.hash === view.diff);
  const shown = revisions[shownAt];
  const previous = revisions[shownAt + 1];
  return (
    <div className="flex flex-col gap-3">
      <ol aria-label={copy.history.label} className="m-0 flex list-none flex-col gap-1 p-0">
        {revisions.map((revision, at) => {
          const rev = skillRevisionLabel(revision);
          const open = revision.hash === view.diff;
          return (
            <li
              key={revision.hash}
              className={cn(
                "flex flex-wrap items-start gap-2.5 rounded-card px-3.5 py-3",
                at === 0 ? "bg-[color-mix(in_srgb,var(--color-mint)_8%,var(--color-card))]" : "bg-card",
              )}
            >
              <span className="mt-0.5 inline-flex items-center rounded-tag bg-[color-mix(in_srgb,var(--color-mint)_16%,transparent)] px-[7px] py-px font-mono text-meta font-semibold text-text-strong">
                {rev}
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-ui font-semibold text-text-strong">{whatOf(revision)}</span>
                <span className="text-meta text-label">{metaOf(revision)}</span>
              </span>
              {at < revisions.length - 1 && (
                <Button asChild variant="quiet" size="xs">
                  <Link
                    to="/skills"
                    search={skillsSearchOf({ ...view, diff: open ? null : revision.hash })}
                    aria-expanded={open}
                  >
                    {open ? copy.history.hideChanges : copy.history.changes}
                  </Link>
                </Button>
              )}
              {at > 0 && detail.assignments.length > 0 && (
                <Button
                  variant="outline"
                  size="xs"
                  disabled={writes.busy}
                  onClick={() =>
                    writes.rollOut.mutate(
                      { skillId: skill.id, pin: revision.hash },
                      {
                        onSuccess: (done) =>
                          say({
                            tone: "done",
                            message: copy.history.rolledBack({ rev, count: done.rolledOut.length }),
                          }),
                        onError: () => say({ tone: "failed", message: copy.history.rollFailed }),
                      },
                    )
                  }
                >
                  {copy.history.rollBack({ rev })}
                </Button>
              )}
            </li>
          );
        })}
      </ol>
      {shown !== undefined && previous !== undefined && (
        <RevisionChanges detail={detail} revision={shown} previous={previous} />
      )}
    </div>
  );
}
