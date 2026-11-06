import type { SkillDetail, SkillsList } from "@hobbots/api";
import { type Agent, memoryScopeKey, type SkillScope, skillRevisionLabel } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { formatDay } from "../../lib/format.ts";
import { MemoryCard } from "../memory/memory-parts.tsx";
import { messages } from "./messages.ts";
import { droppedLine } from "./skill-flags.tsx";
import { SkillRemove } from "./skill-remove.tsx";
import type { Say } from "./skills-flash.ts";
import { type HobDirectory, originOf, originText, projectName, scopeName, skillsSearchOf } from "./skills-model.ts";
import { useSkillWrites } from "./use-skill-writes.ts";

const copy = messages;

/** Where the skill could also go: Everyone, the projects the library knows and each hob, less where it is already. */
const placesFor = (detail: SkillDetail, list: SkillsList, active: ReadonlyArray<Agent>) => {
  const given = new Set(detail.assignments.map((assignment) => memoryScopeKey(assignment.scope)));
  const projects = new Map(
    list.assignments
      .filter((assignment) => assignment.scope._tag === "Project")
      .map((assignment) => [memoryScopeKey(assignment.scope), assignment.scope]),
  );
  const places: Array<{ scope: SkillScope; label: string; sub: string }> = [
    { scope: { _tag: "Everyone" }, label: copy.give.everyone, sub: copy.give.everyoneSub },
    ...[...projects.values()].map((scope) => ({
      scope,
      label: copy.give.project({ name: scope._tag === "Project" ? projectName(scope.identity) : "" }),
      sub: copy.give.projectSub,
    })),
    ...active.map((hob) => ({
      scope: { _tag: "Hob", agentId: hob.id } as const,
      label: hob.name,
      sub: copy.give.hobSub,
    })),
  ];
  return places.filter((place) => !given.has(memoryScopeKey(place.scope)));
};

function GiveTo({
  detail,
  list,
  hobs,
  active,
  say,
}: {
  detail: SkillDetail;
  list: SkillsList;
  hobs: HobDirectory;
  active: ReadonlyArray<Agent>;
  say: Say;
}) {
  const [open, setOpen] = useState(false);
  const writes = useSkillWrites();
  const places = placesFor(detail, list, active);
  if (places.length === 0) return null;
  const rev = skillRevisionLabel({ number: detail.skill.revisions });
  return (
    <>
      <Button variant="outline" aria-expanded={open} onClick={() => setOpen(!open)}>
        {copy.give.open}
      </Button>
      {open && (
        <ul aria-label={copy.give.label} className="m-0 flex list-none flex-col gap-1 p-0 ps-2">
          {places.map((place) => (
            <li key={memoryScopeKey(place.scope)}>
              <button
                type="button"
                disabled={writes.busy}
                onClick={() =>
                  writes.assign.mutate(
                    { skillId: detail.skill.id, scope: place.scope },
                    {
                      onSuccess: () => {
                        setOpen(false);
                        say({ tone: "done", message: copy.give.done({ who: scopeName(place.scope, hobs), rev }) });
                      },
                      onError: () => say({ tone: "failed", message: copy.give.failed }),
                    },
                  )
                }
                className="focus-ring flex w-full cursor-pointer items-center gap-2 rounded-control border-0 bg-transparent px-2.5 py-2 text-start text-ui text-text-strong hover:bg-hover disabled:opacity-50"
              >
                <span className="flex-1">{place.label}</span>
                <span className="text-meta text-label">{place.sub}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function Origin({ detail, list }: { detail: SkillDetail; list: SkillsList }) {
  const latest = detail.revisions[0];
  const first = detail.revisions.at(-1);
  const charms = latest?.charms ?? [];
  const dropped = droppedLine(latest?.dropped ?? []);
  return (
    <MemoryCard label={copy.skill.origin}>
      <h3 className="lbl m-0 text-label">{copy.skill.origin}</h3>
      <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-detail">
        <dt className="text-label">{copy.skill.sourceLabel}</dt>
        <dd className="m-0 break-words">{originText(originOf(detail.skill.sourceId, list.sources))}</dd>
        {latest?.commit != null && (
          <>
            <dt className="text-label">{copy.skill.commit}</dt>
            <dd className="m-0 font-mono">{latest.commit.slice(0, 7)}</dd>
          </>
        )}
        {latest?.label != null && (
          <>
            <dt className="text-label">{copy.skill.version}</dt>
            <dd className="m-0">{latest.label}</dd>
          </>
        )}
        {first !== undefined && (
          <>
            <dt className="text-label">{copy.skill.first}</dt>
            <dd className="m-0">{copy.skill.firstAdded({ when: formatDay(first.addedAt) })}</dd>
          </>
        )}
        <dt className="text-label">{copy.skill.needs}</dt>
        <dd className="m-0">{charms.length === 0 ? copy.skill.noCharm : copy.skill.charms({ charms })}</dd>
        <dt className="text-label">{copy.skill.grants}</dt>
        <dd className="m-0">{copy.skill.grantsNothing}</dd>
        {dropped !== null && (
          <>
            <dt className="text-label">{copy.skill.leftOut}</dt>
            <dd className="m-0">{dropped}</dd>
          </>
        )}
      </dl>
    </MemoryCard>
  );
}

/** Beside a skill: Edit, Also give it to, Remove, and where it came from. */
export function SkillAside({
  detail,
  list,
  hobs,
  active,
  say,
}: {
  detail: SkillDetail;
  list: SkillsList;
  hobs: HobDirectory;
  active: ReadonlyArray<Agent>;
  say: Say;
}) {
  return (
    <aside aria-label={copy.skill.aside} className="flex w-[280px] flex-none flex-col gap-4">
      <MemoryCard label={copy.skill.actions}>
        <h3 className="lbl m-0 text-label">{copy.skill.actions}</h3>
        <Button asChild variant="outline">
          <Link to="/skills" search={skillsSearchOf({ _tag: "Edit", skillId: detail.skill.id })}>
            {copy.skill.edit}
          </Link>
        </Button>
        <GiveTo detail={detail} list={list} hobs={hobs} active={active} say={say} />
        <SkillRemove detail={detail} hobs={hobs} say={say} />
      </MemoryCard>
      <Origin detail={detail} list={list} />
    </aside>
  );
}
