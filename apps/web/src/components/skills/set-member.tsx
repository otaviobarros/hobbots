import type { SkillDetail, SkillsList } from "@hobbots/api";
import { type Agent, type SkillSetSkill, skillRevisionLabel } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { Skeleton } from "@hobbots/ui/components/skeleton";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { skillFileQuery } from "../../api/skills.ts";
import { ReplyMarkdown } from "../markdown/reply-markdown.tsx";
import { MemoryCard } from "../memory/memory-parts.tsx";
import { messages } from "./messages.ts";
import { SkillCopy } from "./skill-copy.tsx";
import { FileList, FileView } from "./skill-instructions.tsx";
import { ReadOnlyNote, type SkillViewOf } from "./skill-tabs.tsx";
import type { Say } from "./skills-flash.ts";
import { instructionsOf, originOf, originText, skillsSearchOf, skillTitle, skillView } from "./skills-model.ts";
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
      {read.isPending && (
        <div role="status" className="flex flex-col gap-2">
          <span className="sr-only">{copy.loading}</span>
          <Skeleton width="80%" />
          <Skeleton width="65%" />
        </div>
      )}
      {read.isError && <p className="m-0 text-ui text-text-secondary">{copy.failed.skill}</p>}
      {read.isSuccess && read.data.text !== null && (
        <ReplyMarkdown content={instructionsOf(read.data.text)} streaming={false} caret={false} />
      )}
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
      <MemoryCard label={copy.skill.actions}>
        <h3 className="lbl m-0 text-label">{copy.skill.actions}</h3>
        <SkillCopy detail={detail} list={list} active={active} say={say} member={member} />
        <Button asChild variant="outline">
          <Link to="/skills" search={skillsSearchOf(skillView(detail.skill.id))}>
            {copy.member.openSet({ set })}
          </Link>
        </Button>
        <span className="text-detail text-text-secondary">{copy.member.noEdit({ set })}</span>
      </MemoryCard>
      <MemoryCard label={copy.skill.origin}>
        <h3 className="lbl m-0 text-label">{copy.skill.origin}</h3>
        <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-detail">
          <dt className="text-label">{copy.skill.sourceLabel}</dt>
          <dd className="m-0 break-words">{originText(originOf(detail.skill.sourceId, list.sources))}</dd>
          <dt className="text-label">{copy.skill.folder}</dt>
          <dd className="m-0 font-mono">{member.path}</dd>
          {latest?.label != null && (
            <>
              <dt className="text-label">{copy.skill.version}</dt>
              <dd className="m-0">{latest.label}</dd>
            </>
          )}
          <dt className="text-label">{copy.skill.needs}</dt>
          <dd className="m-0">
            {member.charms.length === 0 ? copy.skill.noCharm : copy.skill.charms({ charms: member.charms })}
          </dd>
          <dt className="text-label">{copy.skill.grants}</dt>
          <dd className="m-0">{copy.set.grantsNothing}</dd>
        </dl>
      </MemoryCard>
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
  return (
    <div className="flex flex-wrap items-start gap-7">
      <article className="flex min-w-0 max-w-[700px] flex-[1_1_520px] flex-col gap-4">
        <nav aria-label={copy.skill.breadcrumb} className="flex items-center gap-1.5 text-detail text-text-secondary">
          <Link to="/skills" search={{}} className="text-link">
            {copy.title}
          </Link>
          <span aria-hidden>›</span>
          <Link to="/skills" search={skillsSearchOf(skillView(detail.skill.id))} className="text-link">
            {set}
          </Link>
          <span aria-hidden>›</span>
          <span>{skillTitle(member.name)}</span>
        </nav>
        <header className="flex flex-col gap-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <RevTag label={latest?.label ?? skillRevisionLabel({ number: detail.skill.revisions })} />
            <SkillChip tone="set">{copy.member.inSet({ set })}</SkillChip>
          </div>
          <h2 className="m-0 font-heading text-[28px] leading-[34px] font-bold text-text-strong">
            {skillTitle(member.name)}
          </h2>
          <p className="m-0 text-body text-text">{member.description}</p>
          <p className="m-0 text-detail text-label">{copy.member.byline({ set, name: member.name })}</p>
        </header>
        <ReadOnlyNote icon="set">{copy.member.note({ set })}</ReadOnlyNote>
        <MemberInstructions view={view} detail={detail} member={member} />
      </article>
      <MemberAside detail={detail} member={member} list={list} active={active} say={say} />
    </div>
  );
}
