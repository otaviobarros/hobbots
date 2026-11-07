import type { SkillDetail, SkillsList } from "@hobbots/api";
import { type Agent, memoryScopeKey, type SkillScope, skillRevisionLabel } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { formatDay } from "../../lib/format.ts";
import { MemoryCard } from "../memory/memory-parts.tsx";
import { messages } from "./messages.ts";
import { SkillCopy } from "./skill-copy.tsx";
import { droppedLine } from "./skill-flags.tsx";
import { SkillRemove } from "./skill-remove.tsx";
import type { Say } from "./skills-flash.ts";
import {
  agentsFolderOf,
  type HobDirectory,
  originOf,
  originText,
  projectName,
  scopeName,
  skillsSearchOf,
} from "./skills-model.ts";
import { useSkillWrites } from "./use-skill-writes.ts";

const copy = messages;

/** Where the skill could also go: Everyone, each project hobs work in or skills go to, and each hob, less where it is already. */
const placesFor = (detail: SkillDetail, list: SkillsList, active: ReadonlyArray<Agent>) => {
  const given = new Set(detail.assignments.map((assignment) => memoryScopeKey(assignment.scope)));
  const places: Array<{ scope: SkillScope; label: string; sub: string }> = [
    { scope: { _tag: "Everyone" }, label: copy.give.everyone, sub: copy.give.everyoneSub },
    ...list.projects.map((identity) => ({
      scope: { _tag: "Project", identity } as const,
      label: copy.give.project({ name: projectName(identity) }),
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

function Origin({ detail, list, folder }: { detail: SkillDetail; list: SkillsList; folder: string | null }) {
  const latest = detail.revisions[0];
  const first = detail.revisions.at(-1);
  const charms = latest?.charms ?? [];
  const dropped = droppedLine(latest?.dropped ?? []);
  return (
    <MemoryCard label={copy.skill.origin}>
      <h3 className="lbl m-0 text-label">{copy.skill.origin}</h3>
      <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-detail">
        <dt className="text-label">{copy.skill.sourceLabel}</dt>
        <dd className="m-0 break-words">
          {folder === null ? originText(originOf(detail.skill.sourceId, list.sources)) : copy.agents.source({ folder })}
        </dd>
        {folder !== null && (
          <>
            <dt className="text-label">{copy.agents.revisions}</dt>
            <dd className="m-0">{copy.agents.revisionsText}</dd>
            <dt className="text-label">{copy.agents.backups}</dt>
            <dd className="m-0">{copy.agents.backupsText}</dd>
          </>
        )}
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

/**
 * Beside a skill: Edit, Make a copy, Also give it to, Remove, and where it came from. A skill from
 * `~/.agents/skills` has no Edit or Remove (ADR 029): it changes in that folder, or as a copy.
 */
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
  const folder = agentsFolderOf(detail.skill, list.sources, detail.revisions);
  return (
    <aside aria-label={copy.skill.aside} className="flex w-[280px] flex-none flex-col gap-4">
      <MemoryCard label={copy.skill.actions}>
        <h3 className="lbl m-0 text-label">{copy.skill.actions}</h3>
        {folder === null ? (
          <Button asChild variant="outline">
            <Link to="/skills" search={skillsSearchOf({ _tag: "Edit", skillId: detail.skill.id })}>
              {copy.skill.edit}
            </Link>
          </Button>
        ) : (
          <SkillCopy detail={detail} list={list} active={active} say={say} />
        )}
        <GiveTo detail={detail} list={list} hobs={hobs} active={active} say={say} />
        {folder === null ? (
          <SkillRemove detail={detail} hobs={hobs} say={say} />
        ) : (
          <span className="text-detail text-text-secondary">{copy.agents.noEdit}</span>
        )}
      </MemoryCard>
      <Origin detail={detail} list={list} folder={folder} />
    </aside>
  );
}
