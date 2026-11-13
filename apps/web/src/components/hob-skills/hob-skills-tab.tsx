import type { HobSkills } from "@hobbots/api";
import { type Agent, skillRevisionLabel } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { Skeleton } from "@hobbots/ui/components/skeleton";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { useHobSkills } from "../../api/hob-skills.ts";
import { skillsListQuery } from "../../api/skills.ts";
import { LINE_ICONS } from "../../art/icons.ts";
import { formatWhen } from "../../lib/time.ts";
import { charmName } from "../charm-name.ts";
import { RowList } from "../memory/memory-overview.tsx";
import { projectName, skillsSearchOf, skillTitle, skillView } from "../skills/skills-model.ts";
import { RevTag, ScopeTag, SkillsIcon } from "../skills/skills-parts.tsx";
import { HobGive } from "./hob-give.tsx";
import { type CarriedGroup, carriedGroups, charmWarnings } from "./hob-skills-model.ts";
import { messages } from "./messages.ts";

const copy = messages;

/**
 * A hob's Skills tab (ADR 029, The Skills page): how many skills it carries and how it uses them,
 * what needs your hand, what it used lately, and where its skills come from, with the way to its full
 * list in Skills and the picker to give it one.
 */
export function HobSkillsTab({ hob }: { hob: Agent }) {
  const view = useHobSkills(hob.id, hob.configVersion);
  const list = useQuery(skillsListQuery);
  const [said, setSaid] = useState<string | null>(null);
  const failed = view.error ?? list.error;

  if (view.data === undefined || list.data === undefined)
    return failed === null ? (
      <div aria-busy="true" className="flex flex-col gap-3 pt-2">
        <Skeleton width="60ch" />
        <Skeleton width="40%" />
      </div>
    ) : (
      <Failed
        onRetry={() => {
          void view.refetch();
          void list.refetch();
        }}
      />
    );

  return (
    <div className="flex animate-hb-in flex-col gap-4.5 pt-2">
      <p className="m-0 text-ui text-text-secondary">
        {copy.intro({ name: hob.name, count: view.data.skills.length })}
      </p>
      {said !== null && (
        <p role="status" className="m-0 rounded-card bg-notice px-3.5 py-2.5 text-ui text-text-strong">
          {said}
        </p>
      )}
      <Warnings hob={hob} view={view.data} />
      <Lately view={view.data} />
      <Sources hob={hob} groups={carriedGroups(view.data, list.data)} />
      <p className="m-0 text-detail text-label">{copy.clean({ name: hob.name })}</p>
      <div className="flex flex-wrap items-start gap-2">
        <Button asChild variant="outline">
          <Link to="/skills" search={skillsSearchOf({ _tag: "Scope", scope: { _tag: "Hob", agentId: hob.id } })}>
            {copy.openInSkills}
          </Link>
        </Button>
      </div>
      <HobGive hob={hob} view={view.data} list={list.data} onSaid={setSaid} />
    </div>
  );
}

function Failed({ onRetry }: { onRetry: () => void }) {
  return (
    <p role="alert" className="m-0 flex items-center gap-3 rounded-card bg-notice px-4 py-3 text-ui text-text">
      <span className="flex-1">{copy.failed}</span>
      <Button variant="outline" size="xs" onClick={onRetry}>
        {copy.retry}
      </Button>
    </p>
  );
}

/** A skill that needs a Charm the hob lacks, and a name two projects both define. */
function Warnings({ hob, view }: { hob: Agent; view: HobSkills }) {
  const charms = charmWarnings(view).flatMap((one) => one.missingCharms.map((charm) => ({ one, charm })));
  if (charms.length === 0 && view.clashes.length === 0) return null;
  return (
    <ul aria-label={copy.warnings} className="m-0 flex list-none flex-col gap-2 p-0">
      {charms.map(({ one, charm }) => (
        <li
          key={`${one.skillId}-${charm}`}
          className="flex flex-wrap items-center gap-3 rounded-card border border-lantern bg-notice px-4 py-3"
        >
          <span aria-hidden className="text-lantern">
            <SkillsIcon name="flag" />
          </span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="text-ui font-semibold text-text-strong">
              {copy.charm.title({ skill: skillTitle(one.name), charm: charmName(charm) })}
            </span>
            <span className="text-detail text-text-secondary">
              {copy.charm.body({ name: hob.name, charm: charmName(charm) })}
            </span>
          </span>
          <Button asChild variant="outline" size="sm">
            <Link to="/hobs/$hobId/profile" params={{ hobId: hob.id }} search={{ tab: "charms" }}>
              {copy.charm.add}
            </Link>
          </Button>
        </li>
      ))}
      {view.clashes.map((clash) => (
        <li key={clash.name} className="flex items-start gap-3 rounded-card border border-lantern bg-notice px-4 py-3">
          <span aria-hidden className="text-lantern">
            <SkillsIcon name="flag" />
          </span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="text-ui font-semibold text-text-strong">
              {copy.clash.title({ skill: skillTitle(clash.name) })}
            </span>
            <span className="text-detail text-text-secondary">
              {copy.clash.body({
                name: hob.name,
                projects: clash.assignments.flatMap((one) =>
                  one.scope._tag === "Project" ? [projectName(one.scope.identity)] : [],
                ),
              })}
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/** The skills it used last, each once, the most recent first. */
function Lately({ view }: { view: HobSkills }) {
  return (
    <section aria-label={copy.lately} className="flex flex-col gap-1">
      <h2 className="lbl m-0 pb-1 text-label">{copy.lately}</h2>
      {view.lastUsed.length === 0 ? (
        <p className="m-0 px-3 text-ui text-text-secondary">{copy.nothingLately}</p>
      ) : (
        <RowList label={copy.lately}>
          {view.lastUsed.map((use) => (
            <li key={use.id} className="flex items-center gap-3 bg-card px-3 py-2.5">
              {use.skillId === null ? (
                <span className="min-w-0 flex-1 truncate text-ui text-text-strong">{skillTitle(use.name)}</span>
              ) : (
                <Link
                  to="/skills"
                  search={skillsSearchOf(skillView(use.skillId))}
                  className="min-w-0 flex-1 truncate text-ui text-text-strong no-underline hover:underline"
                >
                  {skillTitle(use.name)}
                </Link>
              )}
              {use.number !== null && <RevTag label={skillRevisionLabel({ number: use.number })} />}
              <time dateTime={use.at} className="text-meta whitespace-nowrap text-label">
                {formatWhen(use.at)}
              </time>
            </li>
          ))}
        </RowList>
      )}
    </section>
  );
}

/** One line per place its skills come from: what each gives, and how many of them load. */
function Sources({ hob, groups }: { hob: Agent; groups: ReadonlyArray<CarriedGroup> }) {
  return (
    <section aria-label={copy.from} className="flex flex-col gap-1">
      <h2 className="lbl m-0 pb-1 text-label">{copy.from}</h2>
      <RowList label={copy.from}>
        {groups.map((group) => {
          const loads = group.rows.filter((row) => row.state._tag === "Loads");
          const names = loads.map((row) => skillTitle(row.skill.name));
          const off = group.rows.filter((row) => row.state._tag === "Off").map((row) => skillTitle(row.skill.name));
          const tag =
            group.scope._tag === "Project"
              ? copy.project({ name: projectName(group.scope.identity) })
              : group.scope._tag === "Hob"
                ? copy.own({ name: hob.name })
                : copy.everyone;
          const line =
            group.scope._tag === "Project"
              ? copy.projectLine({ name: hob.name, identity: group.scope.identity, off })
              : group.scope._tag === "Hob"
                ? copy.ownLine({ names })
                : copy.everyoneLine({ names });
          return (
            <li key={group.key} className="flex items-center gap-3 bg-card px-3 py-2.5">
              <ScopeTag scope={group.scope} label={tag} />
              <span className="min-w-0 flex-1 truncate text-detail text-text-secondary">{line}</span>
              <span className="text-meta whitespace-nowrap text-label">
                {copy.ofTotal({ loads: loads.length, total: group.rows.length })}
              </span>
            </li>
          );
        })}
      </RowList>
    </section>
  );
}

/** The Skills tab's icon, the sidebar's Skills mark at tab size. */
export function SkillsTabIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 20 20"
      width={14}
      height={14}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
    >
      <path d={LINE_ICONS.Skills} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
