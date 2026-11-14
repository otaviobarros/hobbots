import type { MembersReport } from "@hobbots/api";
import type { Actor, Agent, RuntimeKind, ThreadMember, User } from "@hobbots/domain";
import { Badge } from "@hobbots/ui/components/badge";
import { Progress } from "@hobbots/ui/components/progress";
import { useQuery } from "@tanstack/react-query";
import { useId } from "react";
import { sidebarQuery } from "../../api/sidebar.ts";
import { formatCompact } from "../../lib/format.ts";
import { PROVIDER_NAMES } from "../../lib/providers.ts";
import { PersonBadge } from "../sidebar/sidebar-faces.tsx";
import { planOf, planSummary, usePlans } from "../usage/plan-summary.ts";
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

/** Today's cost: the plan every turn here runs on, the owner's, and what the camp's hobs spent here. */
export function CostSection({
  report,
  hobs,
  members,
}: {
  report: MembersReport;
  hobs: ReadonlyArray<Agent>;
  members: ReadonlyArray<ThreadMember>;
}) {
  const plans = usePlans();
  const headingId = useId();
  const runtimes = [
    ...new Set(
      members.flatMap((member): ReadonlyArray<RuntimeKind> => {
        const hob = hobs.find((each) => each.id === member.actor.id);
        return hob === undefined ? [] : [hob.runtime];
      }),
    ),
  ];
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
          const summary = planSummary(planOf(plans, runtime), now);
          return (
            <div key={runtime} className="flex flex-col gap-1.5">
              <div className="flex items-baseline gap-2 text-ui">
                <b className="shrink-0 font-semibold">{copy.plan({ provider: PROVIDER_NAMES[runtime] })}</b>
                <span className="min-w-0 flex-1 truncate text-end text-detail text-text-secondary">
                  {summary?.line ?? copy.noPlan}
                </span>
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
        <small className="text-meta text-label">
          {copy.here({ turns, tokens: formatCompact(tokens), owner: yours ? null : ownerName })}
        </small>
      </div>
    </section>
  );
}
