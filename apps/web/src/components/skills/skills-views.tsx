import type { SkillsList } from "@hobbots/api";
import { type Agent, memoryScopeKey, type SkillScope } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { Skeleton } from "@hobbots/ui/components/skeleton";
import { Link } from "@tanstack/react-router";
import { HobSkillsManage } from "../hob-skills/profile-skills.tsx";
import { RowList, StepCards } from "../memory/memory-overview.tsx";
import { messages } from "./messages.ts";
import {
  type HobDirectory,
  libraryGroups,
  projectName,
  searchHits,
  skillsSearchOf,
  skillTitle,
  skillView,
} from "./skills-model.ts";
import { SkillRowLink } from "./skills-overview.tsx";
import { ScopeTag } from "./skills-parts.tsx";

const copy = messages;

const titleOf = (scope: SkillScope, hobs: HobDirectory) => {
  switch (scope._tag) {
    case "Everyone":
      return { title: copy.scope.everyoneTitle, line: copy.scope.everyoneLine };
    case "Project":
      return {
        title: copy.scope.projectTitle({ name: projectName(scope.identity) }),
        line: copy.scope.projectLine({ identity: scope.identity }),
      };
    case "Hob":
      return {
        title: copy.scope.title({ name: hobs.get(scope.agentId)?.name ?? copy.scopes.formerHob }),
        line: copy.scope.hobLine,
      };
  }
};

/** One scope's skills: Everyone, a project or a hob. */
export function SkillsScope({
  scope,
  list,
  hobs,
  now,
}: {
  scope: SkillScope;
  list: SkillsList;
  hobs: HobDirectory;
  now: Date;
}) {
  const hob = scope._tag === "Hob" ? hobs.get(scope.agentId) : undefined;
  if (hob !== undefined) return <HobScope hob={hob} />;
  const key = memoryScopeKey(scope);
  const rows = libraryGroups(list, hobs).find((group) => group.key === key)?.rows ?? [];
  const { title, line } = titleOf(scope, hobs);
  const kind =
    scope._tag === "Everyone"
      ? copy.scopes.everyone
      : scope._tag === "Project"
        ? copy.scopes.projectKind
        : copy.scopes.hobKind;
  return (
    <div className="flex max-w-[900px] flex-col gap-5">
      <header className="flex items-start gap-3.5">
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="self-start">
            <ScopeTag scope={scope} label={kind} />
          </span>
          <h2 className="m-0 font-heading text-[26px] leading-8 font-bold text-text-strong">{title}</h2>
          <p className="m-0 text-ui text-text-secondary">{line}</p>
        </span>
      </header>
      {rows.length === 0 ? (
        <p className="m-0 text-ui text-text-secondary">{copy.scope.empty}</p>
      ) : (
        <RowList label={title}>
          {rows.map((row) => (
            <SkillRowLink key={row.skill.id} row={row} now={now} />
          ))}
        </RowList>
      )}
      {scope._tag !== "Hob" && <p className="m-0 text-detail text-label">{copy.scope.foot}</p>}
    </div>
  );
}

/** What a hob carries, from every scope, with a switch to turn a shared skill off for it alone. */
function HobScope({ hob }: { hob: Agent }) {
  return (
    <div className="flex max-w-[900px] flex-col gap-5">
      <header className="flex items-start gap-3.5">
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="self-start">
            <ScopeTag scope={{ _tag: "Hob", agentId: hob.id }} label={copy.scopes.hobKind} />
          </span>
          <h2 className="m-0 font-heading text-[26px] leading-8 font-bold text-text-strong">
            {copy.scope.title({ name: hob.name })}
          </h2>
        </span>
        <Button asChild variant="outline" size="sm">
          <Link to="/hobs/$hobId" params={{ hobId: hob.id }} search={{ tab: "skills" }}>
            {copy.scope.openPage({ name: hob.name })}
          </Link>
        </Button>
      </header>
      <HobSkillsManage hob={hob} />
    </div>
  );
}

/** What a search found in the library's names and descriptions. */
export function SkillsSearchResults({ q, list }: { q: string; list: SkillsList }) {
  const hits = searchHits(list.skills, q);
  return (
    <div className="flex max-w-[860px] flex-col gap-3.5">
      <h2 className="m-0 font-heading text-[22px] leading-7 font-bold text-text-strong">
        {hits.length === 0 ? copy.search.none({ q }) : copy.search.some({ count: hits.length, q })}
      </h2>
      {hits.length > 0 && (
        <RowList>
          {hits.map((hit) => (
            <li key={hit.skill.id}>
              <Link
                to="/skills"
                search={skillsSearchOf(skillView(hit.skill.id))}
                className="flex w-full flex-col gap-0.5 bg-card px-3.5 py-3 text-start text-text-strong no-underline hover:bg-hover"
              >
                <span className="text-body font-semibold">{skillTitle(hit.skill.name)}</span>
                <span className="text-detail text-text-secondary">
                  {hit.before}
                  {hit.hit !== "" && <mark className="rounded-tag bg-lantern/25 text-text-strong">{hit.hit}</mark>}
                  {hit.after}
                </span>
              </Link>
            </li>
          ))}
        </RowList>
      )}
    </div>
  );
}

/** No skills yet: what a skill is, the three steps, and the ways to add one. */
export function SkillsEmpty() {
  return (
    <div className="flex max-w-[760px] flex-col gap-6 pt-6">
      <header className="flex flex-col gap-2">
        <h2 className="m-0 font-heading text-[28px] leading-[34px] font-bold text-text-strong">{copy.empty.title}</h2>
        <p className="m-0 text-body text-text-secondary">{copy.empty.body}</p>
      </header>
      <StepCards steps={copy.empty.steps} />
      <div className="flex gap-2">
        <Button asChild>
          <Link to="/skills" search={skillsSearchOf({ _tag: "Add", from: "git" })}>
            {copy.add}
          </Link>
        </Button>
        <Button asChild variant="outline">
          <Link to="/skills" search={skillsSearchOf({ _tag: "New" })}>
            {copy.empty.write}
          </Link>
        </Button>
      </div>
    </div>
  );
}

/** While the library is read: the overview's rows as skeletons. */
export function SkillsLoading() {
  return (
    <div aria-busy="true" className="flex max-w-[920px] flex-col gap-2.5">
      <h2 className="lbl m-0 text-label">{copy.overview.library}</h2>
      <div aria-hidden className="flex flex-col gap-1">
        {["40%", "55%", "35%", "48%"].map((width) => (
          <div key={width} className="flex flex-col gap-2 rounded-card bg-card px-3.5 py-3">
            <Skeleton surface="card" width={width} />
            <Skeleton surface="card" width="70%" size="sm" />
          </div>
        ))}
      </div>
      <p role="status" className="m-0 text-detail text-text-secondary">
        {copy.loading}
      </p>
    </div>
  );
}

/** The library did not open: what happened, and Try again. */
/** A list beside the library that is still being read, or could not be: the reason and Try again. */
export function PaneNotRead({
  failed,
  text,
  retry,
  onRetry,
}: {
  failed: boolean;
  text: string;
  retry: string;
  onRetry: () => void;
}) {
  return failed ? (
    <p role="alert" className="m-0 flex items-center gap-3 rounded-card bg-notice px-4 py-3 text-ui text-text">
      <span className="flex-1">{text}</span>
      <Button variant="outline" size="xs" onClick={onRetry}>
        {retry}
      </Button>
    </p>
  ) : (
    <div aria-busy="true" className="flex flex-col gap-2">
      <Skeleton width="40ch" />
      <Skeleton width="60%" />
    </div>
  );
}

export function SkillsFailed({ onRetry, retrying }: { onRetry: () => void; retrying: boolean }) {
  return (
    <div role="alert" className="flex max-w-[680px] flex-col items-start gap-2 rounded-card bg-notice px-4 py-3">
      <b className="font-semibold text-text-strong">{copy.failed.title}</b>
      <span className="text-detail text-text-secondary">{copy.failed.body}</span>
      <Button variant="outline" size="sm" onClick={onRetry} disabled={retrying}>
        {copy.failed.retry}
      </Button>
    </div>
  );
}
