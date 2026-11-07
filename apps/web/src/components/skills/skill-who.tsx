import type { SkillDetail } from "@hobbots/api";
import { type SkillAssignment, skillRevisionLabel } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { Switch } from "@hobbots/ui/components/switch";
import { messages } from "./messages.ts";
import type { Say } from "./skills-flash.ts";
import { type HobDirectory, numberOfPin, scopeName } from "./skills-model.ts";
import { RevTag, ScopeMark } from "./skills-parts.tsx";
import { type SkillWrites, useSkillWrites } from "./use-skill-writes.ts";

const copy = messages;

const subOf = (assignment: SkillAssignment, rev: string) => {
  if (assignment.held) return copy.who.heldSub({ rev });
  if (assignment.scope._tag === "Everyone") return copy.who.everyoneSub;
  return assignment.scope._tag === "Project" ? copy.who.projectSub : copy.who.hobSub;
};

function WhoRow({
  assignment,
  detail,
  hobs,
  writes,
  say,
}: {
  assignment: SkillAssignment;
  detail: SkillDetail;
  hobs: HobDirectory;
  writes: SkillWrites;
  say: Say;
}) {
  const { skill } = detail;
  const who = scopeName(assignment.scope, hobs);
  const rev = skillRevisionLabel({ number: numberOfPin(detail.revisions, assignment.pin) });
  const newest = skillRevisionLabel({ number: skill.revisions });
  const behind = assignment.pin !== skill.latest;
  const failed = () => say({ tone: "failed", message: copy.who.failed });
  const hob = assignment.scope._tag === "Hob" ? hobs.get(assignment.scope.agentId) : undefined;
  return (
    <li className="flex flex-wrap items-center gap-2.5 bg-card px-3.5 py-2.5">
      <ScopeMark scope={assignment.scope} hob={hob} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-ui font-semibold text-text-strong">{who}</span>
        <span className="truncate text-meta text-label">{subOf(assignment, rev)}</span>
      </span>
      <RevTag label={rev} old={behind} />
      <span className="flex items-center gap-2 text-meta text-label">
        <span aria-hidden>{copy.who.onlyWhenAsked}</span>
        <Switch
          aria-label={copy.who.onlyWhenAskedFor({ name: who })}
          checked={assignment.onlyWhenAsked}
          disabled={writes.busy}
          onCheckedChange={(onlyWhenAsked) =>
            writes.assign.mutate(
              { skillId: skill.id, scope: assignment.scope, pin: assignment.pin, onlyWhenAsked },
              {
                onSuccess: () =>
                  say({
                    tone: "done",
                    message: onlyWhenAsked ? copy.who.askedOn({ who, name: skill.name }) : copy.who.askedOff({ who }),
                  }),
                onError: failed,
              },
            )
          }
        />
      </span>
      {behind && (
        <Button
          variant="outline"
          size="xs"
          disabled={writes.busy}
          onClick={() =>
            writes.roll.mutate(
              { assignmentId: assignment.id, pin: skill.latest },
              {
                onSuccess: () => say({ tone: "done", message: copy.who.moved({ who, rev: newest }) }),
                onError: failed,
              },
            )
          }
        >
          {copy.who.move({ rev: newest })}
        </Button>
      )}
      <Button
        variant="quiet"
        size="xs"
        disabled={writes.busy}
        onClick={() =>
          writes.hold.mutate(
            { assignmentId: assignment.id, held: !assignment.held },
            {
              onSuccess: () =>
                say({
                  tone: "done",
                  message: assignment.held ? copy.who.followed({ who }) : copy.who.kept({ who, rev }),
                }),
              onError: failed,
            },
          )
        }
      >
        {assignment.held ? copy.who.follow : copy.who.keep({ rev })}
      </Button>
      <Button
        variant="quiet"
        size="xs"
        disabled={writes.busy}
        onClick={() =>
          writes.unassign.mutate(assignment.id, {
            onSuccess: () => say({ tone: "done", message: copy.who.takenAway({ who }) }),
            onError: failed,
          })
        }
      >
        {copy.who.takeAway}
      </Button>
    </li>
  );
}

/** Who uses it: each place the skill is given, the revision it is on, Keep on, Move and Take it away. */
export function SkillWho({ detail, hobs, say }: { detail: SkillDetail; hobs: HobDirectory; say: Say }) {
  const writes = useSkillWrites();
  if (detail.assignments.length === 0) return <p className="m-0 text-ui text-text-secondary">{copy.who.none}</p>;
  return (
    <div className="flex flex-col gap-3">
      <p className="m-0 text-ui text-text-secondary">{copy.who.intro}</p>
      <ul
        aria-label={copy.skill.who}
        className="m-0 flex list-none flex-col overflow-hidden rounded-card p-0 [&>li+li]:border-t [&>li+li]:border-line"
      >
        {detail.assignments.map((assignment) => (
          <WhoRow key={assignment.id} assignment={assignment} detail={detail} hobs={hobs} writes={writes} say={say} />
        ))}
      </ul>
    </div>
  );
}
