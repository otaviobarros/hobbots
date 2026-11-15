import type { MembersReport } from "@hobbots/api";
import type { Actor, Agent, RuntimeKind, Thread, ThreadMember, User } from "@hobbots/domain";
import { Badge } from "@hobbots/ui/components/badge";
import { Button } from "@hobbots/ui/components/button";
import { Progress } from "@hobbots/ui/components/progress";
import { useQuery } from "@tanstack/react-query";
import { useId } from "react";
import { plansQuery } from "../../api/queries.ts";
import { sidebarQuery } from "../../api/sidebar.ts";
import { formatCompact } from "../../lib/format.ts";
import { PROVIDER_NAMES } from "../../lib/providers.ts";
import { PersonBadge } from "../sidebar/sidebar-faces.tsx";
import { planOf, planSummary } from "../usage/plan-summary.ts";
import { messages } from "./messages.ts";
import { row, sectionTitle } from "./sheet-styles.ts";

// The members sheet's People and Today's cost sections (ADR 039, Members; Status and cost).

const copy = messages.sheet;

/** The camp's people: you, whoever owns the camp, and the owner marked. */
export function PeopleSection({ report, members }: { report: MembersReport; members: ReadonlyArray<ThreadMember> }) {
  const headingId = useId();
  const you = useQuery(sidebarQuery).data?.you;
  const personOf = (actor: Actor): User | undefined => report.people.find((user) => user.id === actor.id);
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-1.5">
      <h3 id={headingId} className={sectionTitle}>
        {copy.people({ total: members.length })}
      </h3>
      <ul aria-labelledby={headingId} className="m-0 flex list-none flex-col p-0">
        {members.map((member) => {
          const person = personOf(member.actor);
          const owner = member.role === "owner";
          // You are the person on this device, whoever owns the camp.
          const isYou = you !== undefined && member.actor.kind === "user" && member.actor.id === you.id;
          return (
            <li key={member.actor.id} className={row}>
              {person === undefined ? (
                <span aria-hidden className="size-8" />
              ) : (
                <span aria-hidden className="contents">
                  <PersonBadge person={person} size="lg" />
                </span>
              )}
              <span className="flex min-w-0 flex-col">
                <b className="flex items-center gap-1.5 text-ui font-semibold">
                  <span className="truncate">{isYou ? messages.picker.you : (person?.name ?? member.actor.id)}</span>
                  {owner && <Badge variant="muted">{copy.owner}</Badge>}
                </b>
                <small className="truncate text-meta text-text-secondary">{isYou ? copy.ownerLine : copy.member}</small>
              </span>
              <span />
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * The runtimes the camp's turns spend: the camp's own brain when it has one, since every hob here
 * thinks with it (brainFor, ADR 017), otherwise each hob's own.
 */
export const campRuntimes = (
  camp: Pick<Thread, "brain">,
  hobs: ReadonlyArray<Pick<Agent, "id" | "runtime">>,
  members: ReadonlyArray<ThreadMember>,
): ReadonlyArray<RuntimeKind> =>
  camp.brain !== null
    ? [camp.brain.runtime]
    : [
        ...new Set(
          members.flatMap((member): ReadonlyArray<RuntimeKind> => {
            const hob = hobs.find((each) => each.id === member.actor.id);
            return hob === undefined ? [] : [hob.runtime];
          }),
        ),
      ];

/** Today's cost: the plan every turn here runs on, the owner's, and what the camp's hobs spent here. */
export function CostSection({
  camp,
  report,
  hobs,
  members,
}: {
  camp: Thread;
  report: MembersReport;
  hobs: ReadonlyArray<Agent>;
  members: ReadonlyArray<ThreadMember>;
}) {
  // The plans' own lifecycle: a slow or failed read is not a plan the hub didn't report.
  const plansRead = useQuery(plansQuery);
  const plans = plansRead.data;
  const plansFailed = plansRead.isError && !plansRead.isFetching;
  const headingId = useId();
  const runtimes = campRuntimes(camp, hobs, members);
  const you = useQuery(sidebarQuery).data?.you;
  // Every turn here runs on the camp owner's sign-in, whoever asked: yours, or theirs by name.
  const owner = report.members.find((member) => member.role === "owner");
  const ownerName = report.people.find((user) => user.id === owner?.actor.id)?.name;
  const yours = owner === undefined || owner.actor.id === you?.id || ownerName === undefined;
  const turns = report.today.reduce((sum, hob) => sum + hob.turns, 0);
  const tokens = report.today.reduce((sum, hob) => sum + hob.tokens, 0);
  const now = new Date();
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-1.5">
      <h3 id={headingId} className={sectionTitle}>
        {copy.cost}
      </h3>
      <div className="flex flex-col gap-1.5 rounded-control bg-card p-3 border-(length:--edge) border-line">
        {runtimes.map((runtime) => {
          const summary = plans === undefined ? null : planSummary(planOf(plans, runtime), now);
          const line =
            plans === undefined ? (plansFailed ? copy.plansFailed : copy.plansLoading) : (summary?.line ?? copy.noPlan);
          return (
            <div key={runtime} className="flex flex-col gap-1.5">
              <div className="flex items-baseline gap-2 text-ui">
                <b className="shrink-0 font-semibold">{copy.plan({ provider: PROVIDER_NAMES[runtime] })}</b>
                <span className="min-w-0 flex-1 truncate text-end text-detail text-text-secondary">{line}</span>
              </div>
              {summary !== null && (
                <Progress
                  size="sm"
                  value={Math.round(summary.left * 100)}
                  tone={summary.level === "ok" ? "default" : summary.level}
                  aria-hidden
                />
              )}
            </div>
          );
        })}
        {plans === undefined && plansFailed && (
          <span role="alert" className="flex items-center gap-2 text-meta text-rose">
            {copy.plansFailedLong}
            <Button type="button" variant="outline" size="xs" onClick={() => void plansRead.refetch()}>
              {copy.retry}
            </Button>
          </span>
        )}
        <small className="text-meta text-label">
          {copy.here({ turns, tokens: formatCompact(tokens), owner: yours ? null : ownerName })}
        </small>
      </div>
    </section>
  );
}
