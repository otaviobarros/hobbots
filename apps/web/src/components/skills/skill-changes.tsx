import type { SkillChange } from "@hobbots/api";
import { type SkillSource, skillRevisionLabel } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { Skeleton } from "@hobbots/ui/components/skeleton";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { skillChangesQuery } from "../../api/skills.ts";
import { formatTime } from "../../lib/time.ts";
import { RowList } from "../memory/memory-overview.tsx";
import { messages } from "./messages.ts";
import { canRollBack, changesByDay, changeText } from "./skill-changes-model.ts";
import type { Say } from "./skills-flash.ts";
import { type HobDirectory, skillsSearchOf, skillTitle, skillView } from "./skills-model.ts";
import { useSkillWrites } from "./use-skill-writes.ts";

const copy = messages.changes;

const GLYPH = {
  saved: "±",
  rolledOut: "↻",
  assigned: "→",
  unassigned: "←",
  held: "‖",
  followed: "→",
  optedOut: "○",
  optedIn: "●",
  removed: "×",
} as const satisfies Record<SkillChange["kind"], string>;

function ChangeRow({
  change,
  hobs,
  sources,
  say,
}: {
  change: SkillChange;
  hobs: HobDirectory;
  sources: ReadonlyArray<SkillSource>;
  say: Say;
}) {
  const writes = useSkillWrites();
  const text = changeText(change, hobs, sources);
  const back = change.previousNumber === null ? null : skillRevisionLabel({ number: change.previousNumber });
  // Roll back moves each place the change moved back to the revision it was on, one by one, as Who
  // uses it does: places that were on different revisions each go back to their own.
  const rollBack = async () => {
    try {
      for (const { assignmentId, from } of change.moved) await writes.roll.mutateAsync({ assignmentId, pin: from });
      const name = skillTitle(change.name);
      say({
        tone: "done",
        message: back === null ? copy.rolledBackEach({ name }) : copy.rolledBackDone({ name, rev: back }),
      });
    } catch {
      say({ tone: "failed", message: copy.rollBackFailed });
    }
  };
  return (
    <li className="flex items-start gap-3 bg-card px-3.5 py-3 [contain-intrinsic-size:auto_64px] [content-visibility:auto]">
      <span
        aria-hidden
        className="flex size-6 shrink-0 items-center justify-center rounded-tile bg-line font-mono text-detail text-text-secondary"
      >
        {GLYPH[change.kind]}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-2 text-meta text-label">
          <span className="font-semibold">{text.kind}</span>
          <time dateTime={change.at}>{formatTime(change.at)}</time>
        </span>
        {change.kind === "removed" ? (
          <span className="text-ui text-text-strong">{text.line}</span>
        ) : (
          <Link
            to="/skills"
            search={skillsSearchOf(skillView(change.skillId))}
            className="text-ui text-text-strong no-underline hover:underline"
          >
            {text.line}
          </Link>
        )}
        {text.note !== null && <span className="text-detail text-text-secondary">{text.note}</span>}
      </span>
      {canRollBack(change) && (
        <Button variant="outline" size="sm" disabled={writes.busy} onClick={() => void rollBack()}>
          {back === null ? copy.rollBackEach : copy.rollBack({ rev: back })}
        </Button>
      )}
    </li>
  );
}

/**
 * What changed (ADR 029, The Skills page): each revision saved with the places its rollout moved and
 * held, each rollout and rollback, and each skill given, taken, held or turned off, newest first, with
 * Roll back where there is a way back.
 */
export function SkillChanges({
  hobs,
  sources,
  say,
  now,
}: {
  hobs: HobDirectory;
  sources: ReadonlyArray<SkillSource>;
  say: Say;
  now: Date;
}) {
  const changes = useQuery(skillChangesQuery);
  return (
    <div className="flex max-w-[860px] flex-col gap-4">
      <header className="flex flex-col gap-1">
        <h2 className="m-0 font-heading text-[26px] leading-8 font-bold text-text-strong">{copy.title}</h2>
        <p className="m-0 text-ui text-text-secondary">{copy.intro}</p>
      </header>
      {changes.data === undefined ? (
        changes.isError ? (
          <p role="alert" className="m-0 flex items-center gap-3 rounded-card bg-notice px-4 py-3 text-ui text-text">
            <span className="flex-1">{copy.failed}</span>
            <Button variant="outline" size="xs" onClick={() => void changes.refetch()}>
              {copy.retry}
            </Button>
          </p>
        ) : (
          <div aria-busy="true" className="flex flex-col gap-2">
            <Skeleton width="50%" />
            <Skeleton width="70%" />
          </div>
        )
      ) : changes.data.changes.length === 0 ? (
        <p className="m-0 text-ui text-text-secondary">{copy.empty}</p>
      ) : (
        changesByDay(changes.data.changes, now).map(({ day, changes: those }) => (
          <section key={day} aria-label={day} className="flex flex-col gap-1.5">
            <h3 className="lbl m-0 text-label">{day}</h3>
            <RowList label={day}>
              {those.map((change) => (
                <ChangeRow
                  key={`${change.at}-${change.skillId}-${change.kind}`}
                  change={change}
                  hobs={hobs}
                  sources={sources}
                  say={say}
                />
              ))}
            </RowList>
          </section>
        ))
      )}
    </div>
  );
}
