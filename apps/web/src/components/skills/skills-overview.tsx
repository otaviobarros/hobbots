import type { SkillsList } from "@hobbots/api";
import { Button } from "@hobbots/ui/components/button";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { skillUpdatesQuery } from "../../api/skill-updates.ts";
import { formatAgo, formatCount } from "../../lib/format.ts";
import { RowList } from "../memory/memory-overview.tsx";
import { GroupLabel } from "../memory/memory-parts.tsx";
import { messages } from "./messages.ts";
import { RepositoryOffers } from "./skill-repository-offer.tsx";
import type { Say } from "./skills-flash.ts";
import { SkillHealthCards } from "./skills-health.tsx";
import {
  type HobDirectory,
  libraryGroups,
  originText,
  type SkillGroup,
  type SkillRow,
  scopeName,
  skillsSearchOf,
  skillTitle,
  skillView,
} from "./skills-model.ts";
import { RevTag, ScopeTag, SkillChip, SkillsIcon } from "./skills-parts.tsx";

const copy = messages;

const rowLink =
  "flex w-full items-start gap-2.5 bg-card px-3.5 py-3 text-start text-text-strong no-underline transition-colors duration-(--dur-fade) hover:bg-hover";

/** Whether an update waits for the skill, and whether it takes clean ones by itself. */
function UpdateChips({ row }: { row: SkillRow }) {
  const updates = useQuery(skillUpdatesQuery).data;
  if (updates === undefined || row.origin?._tag !== "Git") return null;
  const id = row.skill.id;
  return (
    <>
      {updates.updates.some((update) => update.skillId === id) && (
        <SkillChip tone="needs">{copy.chips.updateAvailable}</SkillChip>
      )}
      {updates.automatic.includes(id) && <SkillChip tone="set">{copy.chips.updatesAutomatically}</SkillChip>}
    </>
  );
}

function RowChips({ row }: { row: SkillRow }) {
  const { assignment, origin } = row;
  return (
    <>
      <UpdateChips row={row} />
      {row.set !== null && <SkillChip tone="set">{copy.chips.set({ count: row.set.length })}</SkillChip>}
      {origin?._tag === "AgentsFolder" && <SkillChip tone="later">{copy.chips.agents}</SkillChip>}
      {assignment?.held === true && (
        <SkillChip tone="waiting">
          {row.number === null ? copy.chips.heldOld : copy.chips.held({ rev: copy.revision({ number: row.number }) })}
        </SkillChip>
      )}
      {assignment?.held === false && row.number === null && <SkillChip tone="needs">{copy.chips.older}</SkillChip>}
      {assignment?.onlyWhenAsked === true && <SkillChip tone="waiting">{copy.chips.onlyWhenAsked}</SkillChip>}
    </>
  );
}

/** One skill in a scope's list: its title, revision and what it is for, and where it came from. */
export function SkillRowLink({ row, now }: { row: SkillRow; now: Date }) {
  const { skill } = row;
  return (
    <li>
      <Link to="/skills" search={skillsSearchOf(skillView(skill.id))} className={rowLink}>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-body font-semibold">{row.set === null ? skillTitle(skill.name) : skill.name}</span>
            {row.number !== null && <RevTag label={copy.revision({ number: row.number })} />}
            <RowChips row={row} />
          </span>
          <span className="truncate text-detail text-text-secondary">{skill.description}</span>
        </span>
        <span className="flex flex-none flex-col items-end gap-1 pt-0.5 text-meta whitespace-nowrap text-label">
          <span>{copy.overview.updated({ when: formatAgo(skill.updatedAt, now) })}</span>
          <span className="max-w-[220px] truncate">{originText(row.origin)}</span>
        </span>
      </Link>
    </li>
  );
}

const hintOf = (group: SkillGroup) => {
  if (group.scope === null) return copy.scopes.noneHint;
  if (group.scope._tag === "Everyone") return copy.scopes.everyoneHint;
  return group.scope._tag === "Project" ? copy.scopes.projectHint : copy.scopes.hobHint;
};

function Group({ group, hobs, now }: { group: SkillGroup; hobs: HobDirectory; now: Date }) {
  const label = group.scope === null ? copy.scopes.none : scopeName(group.scope, hobs);
  return (
    <section aria-label={label} className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2 px-0.5 pt-1">
        <ScopeTag scope={group.scope} label={label} />
        <span className="text-meta text-label">{hintOf(group)}</span>
      </div>
      <RowList>
        {group.rows.map((row) => (
          <SkillRowLink key={`${group.key}:${row.skill.id}`} row={row} now={now} />
        ))}
      </RowList>
    </section>
  );
}

/** The overview: the repositories whose skills are offered, the library by scope, then what deserves a look and what each hob carries. */
export function SkillsOverview({
  list,
  hobs,
  say,
  now,
}: {
  list: SkillsList;
  hobs: HobDirectory;
  say: Say;
  now: Date;
}) {
  const groups = libraryGroups(list, hobs);
  return (
    <div className="flex max-w-[920px] flex-col gap-7">
      <RepositoryOffers hobs={hobs} say={say} />
      <section aria-label={copy.overview.library} className="flex flex-col gap-2.5">
        <GroupLabel>
          <h2 className="lbl m-0 text-label">{copy.overview.library}</h2>
          <span className="text-meta text-label tabular-nums">{formatCount(list.skills.length)}</span>
          <span className="ms-auto text-meta text-label">{copy.overview.libraryHint}</span>
        </GroupLabel>
        {groups.map((group) => (
          <Group key={group.key} group={group} hobs={hobs} now={now} />
        ))}
        <div className="flex items-start gap-2.5 rounded-card bg-deep px-3.5 py-2.5 text-ui text-text-secondary">
          <span className="mt-0.5">
            <SkillsIcon name="notice" />
          </span>
          <p className="m-0 flex-1">{copy.overview.note}</p>
          <Button asChild variant="quiet" size="sm" className="flex-none">
            <Link to="/skills" search={skillsSearchOf({ _tag: "Export" })}>
              {copy.overview.export}
            </Link>
          </Button>
        </div>
      </section>
      <SkillHealthCards list={list} hobs={hobs} now={now} />
    </div>
  );
}
