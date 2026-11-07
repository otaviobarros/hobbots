import { Button } from "@hobbots/ui/components/button";
import { Link, useNavigate } from "@tanstack/react-router";
import { FlashLine } from "../memory/memory-parts.tsx";
import { PageSearch } from "../shell/page-search.tsx";
import { PageHeader } from "../shell/pages.tsx";
import { messages } from "./messages.ts";
import { SkillChanges } from "./skill-changes.tsx";
import { SkillEditor } from "./skill-editor.tsx";
import { SkillNew } from "./skill-new.tsx";
import { SkillPage } from "./skill-page.tsx";
import { type Say, useFlash } from "./skills-flash.ts";
import { SkillsImport } from "./skills-import.tsx";
import { type SkillsSearch, type SkillsView, skillsSearchOf, skillsViewOf } from "./skills-model.ts";
import { SkillsNav } from "./skills-nav.tsx";
import { SkillsOverview, WorthALook } from "./skills-overview.tsx";
import { SkillsEmpty, SkillsFailed, SkillsLoading, SkillsScope, SkillsSearchResults } from "./skills-views.tsx";
import { type SkillsReads, useSkills } from "./use-skills.ts";

const copy = messages;

/** The search in the header. Enter searches; clearing it goes back to the overview. */
function SkillsSearchForm({ view }: { view: SkillsView }) {
  const navigate = useNavigate();
  return (
    <PageSearch
      asked={view._tag === "Search" ? view.q : ""}
      copy={copy.search}
      onSearch={(q) => void navigate({ to: "/skills", search: q === "" ? {} : skillsSearchOf({ _tag: "Search", q }) })}
      onClear={() => void navigate({ to: "/skills", search: {} })}
    />
  );
}

const headLine = (reads: SkillsReads) => {
  const list = reads.list.data;
  if (list === undefined) return reads.list.isError ? copy.head.failed : copy.head.loading;
  if (list.skills.length === 0) return copy.head.empty;
  const revisions = list.skills.reduce((sum, skill) => sum + skill.revisions, 0);
  return copy.head.full({ count: list.skills.length, revisions });
};

/** The view's body: the editors and Add a skill open whatever the library holds; the rest read it. */
function ViewBody({ view, reads, say, now }: { view: SkillsView; reads: SkillsReads; say: Say; now: Date }) {
  const projects = reads.list.data?.projects ?? [];
  if (view._tag === "Add")
    return <SkillsImport from={view.from} active={reads.active} projects={projects} hobs={reads.hobs} say={say} />;
  if (view._tag === "New") return <SkillNew active={reads.active} projects={projects} hobs={reads.hobs} say={say} />;
  if (view._tag === "Edit") return <SkillEditor skillId={view.skillId} hobs={reads.hobs} say={say} />;
  const list = reads.list.data;
  if (list === undefined) {
    return reads.list.isError ? (
      <SkillsFailed onRetry={() => void reads.list.refetch()} retrying={reads.list.isFetching} />
    ) : (
      <SkillsLoading />
    );
  }
  switch (view._tag) {
    case "Changes":
      return <SkillChanges hobs={reads.hobs} say={say} now={now} />;
    case "Skill":
      return <SkillPage view={view} list={list} hobs={reads.hobs} active={reads.active} say={say} />;
    case "Search":
      return <SkillsSearchResults q={view.q} list={list} />;
    case "Scope":
      return <SkillsScope scope={view.scope} list={list} hobs={reads.hobs} now={now} />;
    case "Overview":
      return list.skills.length === 0 ? (
        <div className="flex max-w-[760px] flex-col gap-5">
          <SkillsEmpty />
          <WorthALook list={list} />
        </div>
      ) : (
        <SkillsOverview list={list} hobs={reads.hobs} now={now} />
      );
  }
}

/**
 * The Skills page (ADR 029, #1062): the library by scope, a skill's instructions, files, who uses it
 * and its history, Add a skill and the editor. Its views live in the address (STD-REACT-002).
 */
export function SkillsPage({ search }: { search: SkillsSearch }) {
  const view = skillsViewOf(search);
  const reads = useSkills();
  const { flash, say } = useFlash(view);
  const now = new Date();
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <PageHeader
        size="bar"
        icon="Skills"
        title={copy.title}
        intro={headLine(reads)}
        actions={
          <span className="flex items-center gap-2">
            <SkillsSearchForm view={view} />
            <Button asChild>
              <Link to="/skills" search={skillsSearchOf({ _tag: "Add", from: "git" })}>
                {copy.add}
              </Link>
            </Button>
          </span>
        }
      />
      <div className="flex min-h-0 min-w-0 flex-1">
        <SkillsNav view={view} reads={reads} />
        <main aria-label={copy.title} className="min-w-0 flex-1 overflow-y-auto px-8 pt-6 pb-8 max-[1180px]:px-6">
          {flash !== null && <FlashLine message={flash.message} tone={flash.tone} />}
          <ViewBody view={view} reads={reads} say={say} now={now} />
        </main>
      </div>
    </div>
  );
}
