import type { SkillDetail, SkillsList } from "@hobbots/api";
import { skillRevisionLabel } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { Skeleton } from "@hobbots/ui/components/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@hobbots/ui/components/tabs";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { skillQuery, skillsErrorTag, skillUsesQuery } from "../../api/skills.ts";
import { formatCount, formatDay } from "../../lib/format.ts";
import { messages } from "./messages.ts";
import { SkillActivity } from "./skill-activity.tsx";
import { SkillAside } from "./skill-aside.tsx";
import { SkillHistory } from "./skill-history.tsx";
import { SkillInstructions } from "./skill-instructions.tsx";
import { SkillWho } from "./skill-who.tsx";
import type { Say } from "./skills-flash.ts";
import { type HobDirectory, type SkillsView, type SkillTab, skillsSearchOf, skillTitle } from "./skills-model.ts";
import { RevTag } from "./skills-parts.tsx";

const copy = messages;

type SkillViewOf = Extract<SkillsView, { _tag: "Skill" }>;

const addedByOf = (detail: SkillDetail) => {
  const first = detail.revisions.at(-1);
  if (first === undefined) return copy.skill.addedByYou;
  if (first.addedBy._tag === "Hob") return copy.skill.addedByHob;
  return first.addedBy._tag === "Source" ? copy.skill.addedBySource : copy.skill.addedByYou;
};

function SkillTabs({
  view,
  detail,
  hobs,
  say,
}: {
  view: SkillViewOf;
  detail: SkillDetail;
  hobs: HobDirectory;
  say: Say;
}) {
  const navigate = useNavigate();
  const uses = useQuery(skillUsesQuery(detail.skill.id));
  const tabs: ReadonlyArray<{ id: SkillTab | "instructions"; label: string; count: number | null }> = [
    { id: "instructions", label: copy.skill.instructions, count: null },
    { id: "who", label: copy.skill.who, count: detail.assignments.length },
    { id: "history", label: copy.skill.history, count: detail.revisions.length },
    { id: "activity", label: copy.skill.activity, count: uses.data?.total ?? null },
  ];
  return (
    <Tabs
      className="min-w-0"
      value={view.tab ?? "instructions"}
      onValueChange={(tab) =>
        void navigate({
          to: "/skills",
          search: skillsSearchOf({
            ...view,
            tab: tab === "instructions" ? null : (tab as SkillTab),
            file: null,
            diff: null,
          }),
        })
      }
    >
      <TabsList aria-label={copy.skill.tabs}>
        {tabs.map((tab) => (
          <TabsTrigger key={tab.id} value={tab.id}>
            {tab.label}
            {tab.count !== null && <span className="text-meta text-label tabular-nums">{formatCount(tab.count)}</span>}
          </TabsTrigger>
        ))}
      </TabsList>
      <TabsContent value={view.tab ?? "instructions"} className="mt-2">
        <SkillBody view={view} detail={detail} hobs={hobs} say={say} />
      </TabsContent>
    </Tabs>
  );
}

function SkillBody({
  view,
  detail,
  hobs,
  say,
}: {
  view: SkillViewOf;
  detail: SkillDetail;
  hobs: HobDirectory;
  say: Say;
}) {
  if (view.tab === "who") return <SkillWho detail={detail} hobs={hobs} say={say} />;
  if (view.tab === "history") return <SkillHistory view={view} detail={detail} say={say} />;
  if (view.tab === "activity") return <SkillActivity detail={detail} hobs={hobs} />;
  return <SkillInstructions view={view} detail={detail} />;
}

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
  const { skill } = detail;
  const title = skillTitle(skill.name);
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
          </div>
          <h2 className="m-0 font-heading text-[28px] leading-[34px] font-bold text-text-strong">{title}</h2>
          <p className="m-0 text-body text-text">{skill.description}</p>
          <p className="m-0 text-detail text-label">
            <code className="font-mono">{skill.name}</code>
            {` · ${copy.skill.byline({ who: addedByOf(detail), when: formatDay(skill.createdAt) })}`}
          </p>
        </header>
        <SkillTabs view={view} detail={detail} hobs={hobs} say={say} />
      </article>
      <SkillAside detail={detail} list={list} hobs={hobs} active={active} say={say} />
    </div>
  );
}

function SkillLoading() {
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
