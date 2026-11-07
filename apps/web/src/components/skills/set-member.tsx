import type { SkillDetail, SkillsList } from "@hobbots/api";
import { type Agent, type SkillSetSkill, skillRevisionLabel } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { skillFileQuery } from "../../api/skills.ts";
import { messages } from "./messages.ts";
import { SkillCopy } from "./skill-copy.tsx";
import { FileList, FileView } from "./skill-instructions.tsx";
import { ActionsCard, InstructionsText, OriginCard, OriginRow, SkillHeader, SkillLayout } from "./skill-layout.tsx";
import { ReadOnlyNote, type SkillViewOf } from "./skill-tabs.tsx";
import type { Say } from "./skills-flash.ts";
import { originOf, originText, skillsSearchOf, skillTitle, skillView } from "./skills-model.ts";
import { RevTag, SkillChip } from "./skills-parts.tsx";

const copy = messages;

/** The skill's `SKILL.md`, as its instructions, then its own files, each read-only. */
function MemberInstructions({
  view,
  detail,
  member,
}: {
  view: SkillViewOf;
  detail: SkillDetail;
  member: SkillSetSkill;
}) {
  const latest = detail.revisions[0];
  const read = useQuery({
    ...skillFileQuery(detail.skill.id, detail.skill.latest, `${member.path}/SKILL.md`),
    enabled: latest !== undefined,
  });
  if (latest === undefined) return null;
  const own = latest.files.filter((file) => file.path.startsWith(`${member.path}/`));
  return (
    <div className="flex flex-col gap-4">
      <InstructionsText read={{ ...read, text: read.data?.text }} />
      <FileList view={view} revision={latest} files={own} />
      {view.file !== null && (
        <FileView
          view={view}
          revision={latest}
          path={view.file}
          note={copy.member.fileReadOnly({ set: detail.skill.name })}
        />
      )}
    </div>
  );
}

/** Beside a skill of a set: Make a copy, the set to open, and where it came from. */
function MemberAside({
  detail,
  member,
  list,
  active,
  say,
}: {
  detail: SkillDetail;
  member: SkillSetSkill;
  list: SkillsList;
  active: ReadonlyArray<Agent>;
  say: Say;
}) {
  const set = detail.skill.name;
  const latest = detail.revisions[0];
  return (
    <aside aria-label={copy.skill.aside} className="flex w-[280px] flex-none flex-col gap-4">
      <ActionsCard>
        <SkillCopy detail={detail} list={list} active={active} say={say} member={member} />
        <Button asChild variant="outline">
          <Link to="/skills" search={skillsSearchOf(skillView(detail.skill.id))}>
            {copy.member.openSet({ set })}
          </Link>
        </Button>
        <span className="text-detail text-text-secondary">{copy.member.noEdit({ set })}</span>
      </ActionsCard>
      <OriginCard>
        <OriginRow label={copy.skill.sourceLabel}>
          {originText(originOf(detail.skill.sourceId, list.sources))}
        </OriginRow>
        <OriginRow label={copy.skill.folder} mono>
          {member.path}
        </OriginRow>
        {latest?.label != null && <OriginRow label={copy.skill.version}>{latest.label}</OriginRow>}
        <OriginRow label={copy.skill.needs}>
          {member.charms.length === 0 ? copy.skill.noCharm : copy.skill.charms({ charms: member.charms })}
        </OriginRow>
        <OriginRow label={copy.skill.grants}>{copy.set.grantsNothing}</OriginRow>
      </OriginCard>
    </aside>
  );
}

/**
 * A skill of a set, read-only (ADR 029, Skill sets): it changes only with a new version of its set,
 * or as a copy of its own. Who has it, its history and its uses are the set's.
 */
export function SetMemberPage({
  view,
  detail,
  member,
  list,
  active,
  say,
}: {
  view: SkillViewOf;
  detail: SkillDetail;
  member: SkillSetSkill;
  list: SkillsList;
  active: ReadonlyArray<Agent>;
  say: Say;
}) {
  const set = detail.skill.name;
  const latest = detail.revisions[0];
  const title = skillTitle(member.name);
  return (
    <SkillLayout
      trail={[
        {
          key: "set",
          step: (
            <Link to="/skills" search={skillsSearchOf(skillView(detail.skill.id))} className="text-link">
              {set}
            </Link>
          ),
        },
        { key: "skill", step: <span>{title}</span> },
      ]}
      aside={<MemberAside detail={detail} member={member} list={list} active={active} say={say} />}
    >
      <SkillHeader
        tags={
          <>
            <RevTag label={latest?.label ?? skillRevisionLabel({ number: detail.skill.revisions })} />
            <SkillChip tone="set">{copy.member.inSet({ set })}</SkillChip>
          </>
        }
        title={title}
        description={member.description}
        byline={copy.member.byline({ set, name: member.name })}
      />
      <ReadOnlyNote icon="set">{copy.member.note({ set })}</ReadOnlyNote>
      <MemberInstructions view={view} detail={detail} member={member} />
    </SkillLayout>
  );
}
