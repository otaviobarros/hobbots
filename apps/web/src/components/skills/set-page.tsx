import type { SkillDetail, SkillsList } from "@hobbots/api";
import { type Agent, type SkillId, type SkillSetSkill, skillRevisionLabel } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { skillUsesQuery } from "../../api/skills.ts";
import { formatCount, formatDay } from "../../lib/format.ts";
import { RowList } from "../memory/memory-overview.tsx";
import { MemoryCard } from "../memory/memory-parts.tsx";
import { messages } from "./messages.ts";
import { GiveTo } from "./skill-aside.tsx";
import { droppedLine } from "./skill-flags.tsx";
import { ActionsCard, OriginCard, OriginRow, SkillHeader, SkillLayout } from "./skill-layout.tsx";
import { SkillRemove } from "./skill-remove.tsx";
import { addedByOf, ReadOnlyNote, SkillTabs, type SkillViewOf } from "./skill-tabs.tsx";
import type { Say } from "./skills-flash.ts";
import {
  type HobDirectory,
  memberView,
  originOf,
  originText,
  scopeName,
  sharedFoldersOf,
  skillsSearchOf,
} from "./skills-model.ts";
import { RevTag, ScopeTag, SkillChip } from "./skills-parts.tsx";

const copy = messages;

const sectionHead = "flex flex-wrap items-center gap-2 px-0.5";

/** One skill of a set: its name as you type it, what it is for, and how often hobs used it. */
function SetSkillLink({ setId, row }: { setId: SkillId; row: SetSkillRow }) {
  const { member, used } = row;
  return (
    <li>
      <Link
        to="/skills"
        search={skillsSearchOf(memberView(setId, member.name))}
        className="flex w-full items-center gap-2.5 bg-card px-3 py-2 text-start text-text-strong no-underline hover:bg-hover"
      >
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex items-baseline gap-2">
            <span className="text-ui font-semibold">{member.name}</span>
            <code className="font-mono text-meta text-text-secondary">{`/${member.name}`}</code>
          </span>
          <span className="truncate text-detail text-text-secondary">{member.description}</span>
        </span>
        <span className="text-meta whitespace-nowrap text-label">{copy.set.used({ count: used })}</span>
      </Link>
    </li>
  );
}

/** A set's skills: each opens read-only, with how often hobs used it. */
function SetSkills({ detail, skills }: { detail: SkillDetail; skills: ReadonlyArray<SetSkillRow> }) {
  const first = skills[0]?.member.name;
  return (
    <section aria-label={copy.set.skillsLabel} className="flex flex-col gap-1.5">
      <div className={sectionHead}>
        <h3 className="lbl m-0 text-label">{copy.set.skills}</h3>
        <span className="text-meta text-label tabular-nums">{formatCount(skills.length)}</span>
        {first !== undefined && (
          <span className="ms-auto text-meta text-label">
            {copy.set.typeHint({ name: first, set: detail.skill.name })}
          </span>
        )}
      </div>
      <RowList label={copy.set.skillsLabel}>
        {skills.map((row) => (
          <SetSkillLink key={row.member.name} setId={detail.skill.id} row={row} />
        ))}
      </RowList>
    </section>
  );
}

/** The files a set's skills share, each with how many of them link to it. */
function SharedFiles({ shared, count }: { shared: NonNullable<SkillDetail["shared"]>; count: number }) {
  if (shared.length === 0) return null;
  return (
    <MemoryCard label={copy.set.shared}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="lbl m-0 text-label">{copy.set.shared}</h3>
        <span className="text-meta text-label tabular-nums">{formatCount(shared.length)}</span>
        <span className="ms-auto text-meta text-label">{copy.set.sharedHint}</span>
      </div>
      <ul className="m-0 flex list-none flex-col p-0 [&>li+li]:border-t [&>li+li]:border-line">
        {shared.map((file) => (
          <li key={file.path} className="flex items-center gap-2.5 py-1.5 text-ui">
            <span aria-hidden className="w-[18px] text-center font-mono text-meta font-bold text-label">
              {file.path.toLowerCase().endsWith(".md") ? "MD" : "··"}
            </span>
            <code className="min-w-0 flex-1 truncate font-mono text-detail text-moonlight">{file.path}</code>
            <span className="text-meta whitespace-nowrap text-label">
              {copy.set.linkedBy({ count: file.linkedBy.length, all: file.linkedBy.length === count })}
            </span>
          </li>
        ))}
      </ul>
    </MemoryCard>
  );
}

interface SetSkillRow {
  readonly member: SkillSetSkill;
  readonly used: number;
}

/** Beside a set: Also give it to, Who uses it, Remove, and where it came from. */
function SetAside({
  view,
  detail,
  list,
  hobs,
  active,
  say,
}: {
  view: SkillViewOf;
  detail: SkillDetail;
  list: SkillsList;
  hobs: HobDirectory;
  active: ReadonlyArray<Agent>;
  say: Say;
}) {
  const latest = detail.revisions[0];
  const charms = latest?.charms ?? [];
  const dropped = droppedLine(latest?.dropped ?? []);
  const version = copy.set.version({ label: latest?.label ?? null, commit: latest?.commit ?? null });
  return (
    <aside aria-label={copy.set.aside} className="flex w-[280px] flex-none flex-col gap-4">
      <ActionsCard>
        <GiveTo detail={detail} list={list} hobs={hobs} active={active} say={say} />
        <Button asChild variant="outline">
          <Link to="/skills" search={skillsSearchOf({ ...view, tab: "who", file: null, diff: null })}>
            {copy.set.whoUses}
          </Link>
        </Button>
        <SkillRemove detail={detail} hobs={hobs} say={say} label={copy.set.remove} />
      </ActionsCard>
      <OriginCard>
        <OriginRow label={copy.skill.sourceLabel}>
          {originText(originOf(detail.skill.sourceId, list.sources))}
        </OriginRow>
        {version !== "" && <OriginRow label={copy.skill.version}>{version}</OriginRow>}
        <OriginRow label={copy.skill.leftOut}>{dropped ?? copy.set.leftOutNothing}</OriginRow>
        <OriginRow label={copy.skill.needs}>
          {charms.length === 0 ? copy.skill.noCharm : copy.set.needsSome({ charms })}
        </OriginRow>
        <OriginRow label={copy.skill.grants}>{copy.set.grantsNothing}</OriginRow>
      </OriginCard>
    </aside>
  );
}

/**
 * A set (ADR 029, Skill sets): a plugin's skills and the files they share, which come and update
 * together. Each skill opens read-only; the set is given out, held and removed as one.
 */
export function SetPage({
  view,
  detail,
  list,
  hobs,
  active,
  say,
}: {
  view: SkillViewOf;
  detail: SkillDetail;
  list: SkillsList;
  hobs: HobDirectory;
  active: ReadonlyArray<Agent>;
  say: Say;
}) {
  const uses = useQuery(skillUsesQuery(detail.skill.id));
  const { skill } = detail;
  const latest = detail.revisions[0];
  const members = latest?.set?.skills ?? [];
  const shared = detail.shared ?? [];
  const folders = sharedFoldersOf(shared);
  const usedOf = (name: string) => uses.data?.members.find((one) => one.name === name)?.total ?? 0;
  const rows = members.map((member) => ({ member, used: usedOf(member.name) }));
  const week = list.usesThisWeek.find((one) => one.skillId === skill.id)?.count ?? 0;
  const scope = detail.assignments[0]?.scope;
  const byline = [
    copy.set.byline({ who: addedByOf(detail), when: formatDay(skill.createdAt) }),
    ...(folders.length === 0 ? [] : [copy.set.sharesIn({ folders })]),
  ].join(" · ");
  return (
    <SkillLayout
      trail={[{ key: "set", step: <span>{skill.name}</span> }]}
      aside={<SetAside view={view} detail={detail} list={list} hobs={hobs} active={active} say={say} />}
    >
      <SkillHeader
        tags={
          <>
            {scope !== undefined && <ScopeTag scope={scope} label={scopeName(scope, hobs)} />}
            <RevTag label={latest?.label ?? skillRevisionLabel({ number: skill.revisions })} />
            <SkillChip tone="set">{copy.chips.set({ count: members.length })}</SkillChip>
            <span className="text-meta text-label">{copy.set.uses({ count: week })}</span>
          </>
        }
        title={skill.name}
        description={skill.description}
        byline={byline}
      />
      <ReadOnlyNote icon="set">{copy.set.note({ folders })}</ReadOnlyNote>
      <SkillTabs
        view={view}
        detail={detail}
        hobs={hobs}
        first={{
          label: copy.set.tab,
          count: members.length,
          body: (
            <div className="flex flex-col gap-4">
              <SetSkills detail={detail} skills={rows} />
              <SharedFiles shared={shared} count={members.length} />
            </div>
          ),
        }}
        say={say}
      />
    </SkillLayout>
  );
}
