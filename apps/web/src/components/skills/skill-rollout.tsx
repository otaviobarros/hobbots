import type { SkillDetail } from "@hobbots/api";
import { type SkillAssignment, type SkillAssignmentId, skillRevisionLabel } from "@hobbots/domain";
import { Switch } from "@hobbots/ui/components/switch";
import { messages } from "./messages.ts";
import { type HobDirectory, numberOfPin, scopeName } from "./skills-model.ts";
import { ScopeMark } from "./skills-parts.tsx";

const copy = messages;

/**
 * Which places an edit moves: what you switched, else whether each follows edits now. A place given
 * the skill while the editor is open follows its own hold, so it is never held back unasked.
 */
export type RollOutChoice = ReadonlyMap<SkillAssignmentId, boolean>;

export const movesWith = (choice: RollOutChoice) => (assignment: SkillAssignment) =>
  choice.get(assignment.id) ?? !assignment.held;

/** The places an edit rolls out to, each switched on unless it is kept on its revision. */
export function RollOut({
  detail,
  hobs,
  now,
  next,
  choice,
  onToggle,
}: {
  detail: SkillDetail;
  hobs: HobDirectory;
  now: string;
  next: string;
  choice: RollOutChoice;
  onToggle: (id: SkillAssignmentId, on: boolean) => void;
}) {
  const moves = movesWith(choice);
  const count = detail.assignments.filter(moves).length;
  return (
    <section aria-label={copy.rollout.title({ count })} className="flex flex-col gap-2.5 rounded-card bg-card p-4">
      <h3 className="m-0 font-heading text-[16px] leading-[22px] font-bold text-text-strong">
        {copy.rollout.title({ count })}
      </h3>
      <p className="m-0 text-detail text-text-secondary">{copy.rollout.body({ next, now })}</p>
      <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
        {detail.assignments.map((assignment) => {
          const who = scopeName(assignment.scope, hobs);
          const on = moves(assignment);
          const hob = assignment.scope._tag === "Hob" ? hobs.get(assignment.scope.agentId) : undefined;
          const stays = skillRevisionLabel({ number: numberOfPin(detail.revisions, assignment.pin) });
          return (
            <li key={assignment.id} className="flex items-center gap-2.5 px-1 py-1.5">
              <ScopeMark scope={assignment.scope} hob={hob} />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-ui text-text-strong">{who}</span>
                <span className="text-meta text-label">
                  {on ? copy.rollout.follows : copy.rollout.held({ rev: stays })}
                </span>
              </span>
              <Switch
                checked={on}
                aria-label={copy.rollout.moves({ who, rev: next })}
                onCheckedChange={(checked) => onToggle(assignment.id, checked)}
              />
            </li>
          );
        })}
      </ul>
    </section>
  );
}
