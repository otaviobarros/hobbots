import type { SkillDetail } from "@hobbots/api";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@hobbots/ui/components/tabs";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { skillUsesQuery } from "../../api/skills.ts";
import { formatCount } from "../../lib/format.ts";
import { messages } from "./messages.ts";
import { SkillActivity } from "./skill-activity.tsx";
import { SkillHistory } from "./skill-history.tsx";
import { SkillWho } from "./skill-who.tsx";
import type { Say } from "./skills-flash.ts";
import { type HobDirectory, type SkillsView, type SkillTab, skillsSearchOf } from "./skills-model.ts";
import { SkillsIcon } from "./skills-parts.tsx";

const copy = messages;

export type SkillViewOf = Extract<SkillsView, { _tag: "Skill" }>;

/** Who added a skill first, as its byline says it. */
export const addedByOf = (detail: SkillDetail) => {
  const first = detail.revisions.at(-1);
  if (first === undefined) return copy.skill.addedByYou;
  if (first.addedBy._tag === "Hob") return copy.skill.addedByHob;
  return first.addedBy._tag === "Source" ? copy.skill.addedBySource : copy.skill.addedByYou;
};

/** What the first tab shows: a skill's instructions, or a set's skills and the files they share. */
export interface FirstTab {
  readonly label: string;
  readonly count: number | null;
  readonly body: React.ReactNode;
}

/** A skill's or a set's tabs: the first one, then Who uses it, History and Activity. */
export function SkillTabs({
  view,
  detail,
  hobs,
  first,
  say,
}: {
  view: SkillViewOf;
  detail: SkillDetail;
  hobs: HobDirectory;
  first: FirstTab;
  say: Say;
}) {
  const navigate = useNavigate();
  const uses = useQuery(skillUsesQuery(detail.skill.id));
  const tabs: ReadonlyArray<{ id: SkillTab | "instructions"; label: string; count: number | null }> = [
    { id: "instructions", label: first.label, count: first.count },
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
        <SkillBody view={view} detail={detail} hobs={hobs} first={first} say={say} />
      </TabsContent>
    </Tabs>
  );
}

function SkillBody({
  view,
  detail,
  hobs,
  first,
  say,
}: {
  view: SkillViewOf;
  detail: SkillDetail;
  hobs: HobDirectory;
  first: FirstTab;
  say: Say;
}) {
  if (view.tab === "who") return <SkillWho detail={detail} hobs={hobs} say={say} />;
  if (view.tab === "history") return <SkillHistory view={view} detail={detail} say={say} />;
  if (view.tab === "activity") return <SkillActivity detail={detail} hobs={hobs} />;
  return first.body;
}

/** Why a skill has no editor, and where it is changed instead: its folder, or its set (ADR 029). */
export function ReadOnlyNote({ children, icon = "lock" }: { children: React.ReactNode; icon?: "lock" | "set" }) {
  return (
    <div role="note" className="flex items-start gap-2.5 rounded-card bg-panel px-3.5 py-3 text-ui text-text-secondary">
      <span className="mt-0.5 flex-none">
        <SkillsIcon name={icon} />
      </span>
      <span>{children}</span>
    </div>
  );
}
