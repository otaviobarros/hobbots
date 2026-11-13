import { AgentId, type Criterion, type CriterionState, type TaskTree } from "@hobbots/domain";
import { Badge } from "@hobbots/ui/components/badge";
import type { ComponentProps } from "react";
import type { HobLookup } from "../quest/use-work.ts";
import { workCard } from "../quest/work-model.ts";
import { messages } from "./messages.ts";

const copy = messages.sheet;

/** How each state's tag reads: accepted is done, rework waits on the lead, the rest stay quiet. */
const VARIANT: Readonly<Record<CriterionState, ComponentProps<typeof Badge>["variant"]>> = {
  open: "waiting",
  accepted: "done",
  "needs-rework": "queued",
  waived: "muted",
};

/** Who last decided a criterion, as the sheet names them. */
const decider = (criterion: Criterion, hobs: HobLookup): string | null => {
  const by = criterion.decided?.by;
  if (by === undefined) return null;
  return by.kind === "user" ? copy.byYou : by.kind === "hub" ? copy.byHub : hobs(AgentId.make(by.id)).name;
};

/**
 * A quest's acceptance criteria and where each stands (#1445): accepted on evidence, needing
 * rework, waived or not checked yet, with the artifact versions it was accepted on and who decided
 * last, and why. It shows only what the hub records; nothing here changes them.
 */
export function QuestCriteria({ tree, hobs }: { tree: TaskTree; hobs: HobLookup }) {
  const criteria = workCard(tree)?.quest?.criteria ?? [];
  if (criteria.length === 0) return null;
  return (
    <section aria-label={copy.criteria} className="flex flex-col gap-2">
      <h3 className="m-0 text-meta font-semibold text-label">{copy.criteria}</h3>
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {criteria.map((criterion) => {
          const who = decider(criterion, hobs);
          return (
            <li key={criterion.id} className="flex flex-col gap-0.5 text-ui">
              <span className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 text-text-strong wrap-anywhere">{criterion.text}</span>
                {!criterion.required && <span className="text-detail text-label">{copy.optional}</span>}
                <Badge variant={VARIANT[criterion.state]}>{copy.criterion[criterion.state]}</Badge>
              </span>
              {criterion.evidence.map((each) => (
                <span key={each.artifactId} className="text-detail text-text-secondary">
                  {copy.evidence({ label: each.label, version: each.version })}
                  {each.voidedAt !== null && <> · {copy.voided}</>}
                </span>
              ))}
              {who !== null && criterion.decided !== null && (
                <span className="text-detail text-text-secondary wrap-anywhere">
                  {copy.decidedBy({ who, reason: criterion.decided.reason })}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
