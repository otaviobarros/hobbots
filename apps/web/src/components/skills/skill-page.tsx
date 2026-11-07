import type { SkillsList } from "@hobbots/api";
import { skillRevisionLabel } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { Skeleton } from "@hobbots/ui/components/skeleton";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { skillQuery, skillsErrorTag } from "../../api/skills.ts";
import { formatDay } from "../../lib/format.ts";
import { messages } from "./messages.ts";
import { SetMemberPage } from "./set-member.tsx";
import { SetPage } from "./set-page.tsx";
import { SkillAside } from "./skill-aside.tsx";
import { SkillInstructions } from "./skill-instructions.tsx";
import { addedByOf, ReadOnlyNote, SkillTabs, type SkillViewOf } from "./skill-tabs.tsx";
import type { Say } from "./skills-flash.ts";
import { agentsFolderOf, type HobDirectory, skillTitle } from "./skills-model.ts";
import { RevTag, SkillChip } from "./skills-parts.tsx";

const copy = messages;

/** A skill: its instructions and files, who uses it and its history, with what you can do beside it. */
export function SkillPage({
  view,
  list,
  hobs,
  active,
  say,
}: {
  view: SkillViewOf;
  list: SkillsList;
  hobs: HobDirectory;
  active: Parameters<typeof SkillAside>[0]["active"];
  say: Say;
}) {
  const read = useQuery(skillQuery(view.skillId));
  if (read.isPending) return <SkillLoading />;
  if (read.isError)
    return <SkillNotOpen gone={skillsErrorTag(read.error) === "SkillMissing"} onRetry={() => void read.refetch()} />;
  const detail = read.data;
  const set = detail.revisions[0]?.set ?? null;
  // A set has no SKILL.md of its own (ADR 029, Skill sets): its page lists its skills, and each opens read-only.
  if (set !== null) {
    const member = view.member === null ? undefined : set.skills.find((one) => one.name === view.member);
    if (member !== undefined)
      return <SetMemberPage view={view} detail={detail} member={member} list={list} active={active} say={say} />;
    return <SetPage view={view} detail={detail} list={list} hobs={hobs} active={active} say={say} />;
  }
  const { skill } = detail;
  const title = skillTitle(skill.name);
  const folder = agentsFolderOf(skill, list.sources, detail.revisions);
  return (
    <div className="flex flex-wrap items-start gap-7">
      <article className="flex min-w-0 max-w-[700px] flex-[1_1_520px] flex-col gap-4">
        <nav aria-label={copy.skill.breadcrumb} className="flex items-center gap-1.5 text-detail text-text-secondary">
          <Link to="/skills" search={{}} className="text-link">
            {copy.title}
          </Link>
          <span aria-hidden>›</span>
          <span>{title}</span>
        </nav>
        <header className="flex flex-col gap-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <RevTag label={skillRevisionLabel({ number: skill.revisions })} />
            {folder !== null && <SkillChip tone="later">{copy.chips.agents}</SkillChip>}
          </div>
          <h2 className="m-0 font-heading text-[28px] leading-[34px] font-bold text-text-strong">{title}</h2>
          <p className="m-0 text-body text-text">{skill.description}</p>
          <p className="m-0 text-detail text-label">
            <code className="font-mono">{skill.name}</code>
            {` · ${
              folder === null
                ? copy.skill.byline({ who: addedByOf(detail), when: formatDay(skill.createdAt) })
                : copy.agents.byline({ when: formatDay(skill.createdAt) })
            }`}
          </p>
        </header>
        {folder !== null && <ReadOnlyNote>{copy.agents.note({ folder })}</ReadOnlyNote>}
        <SkillTabs
          view={view}
          detail={detail}
          hobs={hobs}
          first={{
            label: copy.skill.instructions,
            count: null,
            body: <SkillInstructions view={view} detail={detail} fromFolder={folder !== null} />,
          }}
          say={say}
        />
      </article>
      <SkillAside detail={detail} list={list} hobs={hobs} active={active} say={say} />
    </div>
  );
}

export function SkillLoading() {
  return (
    <div aria-busy="true" className="flex max-w-[700px] flex-col gap-3">
      <Skeleton width="30%" />
      <Skeleton width="60%" />
      <Skeleton width="80%" />
      <p role="status" className="sr-only">
        {copy.loading}
      </p>
    </div>
  );
}

function SkillNotOpen({ gone, onRetry }: { gone: boolean; onRetry: () => void }) {
  return (
    <div role="alert" className="flex flex-wrap items-center gap-3 text-ui text-text-secondary">
      <span>{gone ? copy.failed.gone : copy.failed.skill}</span>
      {gone ? (
        <Button asChild variant="outline" size="sm">
          <Link to="/skills" search={{}}>
            {copy.failed.back}
          </Link>
        </Button>
      ) : (
        <Button variant="outline" size="sm" onClick={onRetry}>
          {copy.failed.retry}
        </Button>
      )}
    </div>
  );
}
