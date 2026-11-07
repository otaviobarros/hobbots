import type { SkillsList } from "@hobbots/api";
import { memoryScopeKey } from "@hobbots/domain";
import { Link } from "@tanstack/react-router";
import { useWaitingProposals } from "../../api/skill-proposals.ts";
import { formatCount } from "../../lib/format.ts";
import { NavSkeleton } from "../memory/memory-nav.tsx";
import { messages } from "./messages.ts";
import { type ScopeEntry, type SkillsView, scopeEntries, skillsSearchOf } from "./skills-model.ts";
import { ScopeMark, SkillsIcon } from "./skills-parts.tsx";
import type { SkillsReads } from "./use-skills.ts";

const copy = messages;

const EXACT = { exact: true } as const;

const row =
  "flex w-full min-h-row-min items-center gap-2.5 rounded-control px-2.5 py-2 text-start text-text-strong no-underline transition-colors duration-(--dur-fade) hover:bg-hover aria-[current=page]:bg-card";

function NavLabel({ children }: { children: React.ReactNode }) {
  return <h2 className="lbl m-0 px-2.5 pt-3.5 pb-1 text-meta text-label">{children}</h2>;
}

function ScopeLink({ entry, current }: { entry: ScopeEntry; current: boolean }) {
  return (
    <Link
      to="/skills"
      search={skillsSearchOf({ _tag: "Scope", scope: entry.scope })}
      activeOptions={EXACT}
      aria-current={current ? "page" : undefined}
      className={row}
    >
      <ScopeMark scope={entry.scope} hob={entry.hob} />
      <span className="min-w-0 flex-1 truncate text-ui">{entry.name}</span>
      <span className="text-meta text-label tabular-nums">{formatCount(entry.count)}</span>
    </Link>
  );
}

/** The scopes beside the page: the overview, then Everyone and each project, then every hob. */
export function SkillsNav({ view, reads }: { view: SkillsView; reads: SkillsReads }) {
  const list: SkillsList | undefined = reads.list.data;
  const entries = scopeEntries(list, reads.active, reads.hobs);
  const open = view._tag === "Scope" ? memoryScopeKey(view.scope) : null;
  const waiting = useWaitingProposals().length;
  return (
    <nav
      aria-label={copy.nav.label}
      className="flex w-[260px] flex-none flex-col gap-0.5 overflow-y-auto border-e border-line bg-panel px-2.5 py-3 max-[1180px]:w-[220px]"
    >
      <Link
        to="/skills"
        search={{}}
        activeOptions={EXACT}
        aria-current={view._tag === "Overview" ? "page" : undefined}
        className={row}
      >
        <span className="text-text-secondary">
          <SkillsIcon name="overview" />
        </span>
        <span className="flex-1 text-ui">{copy.nav.overview}</span>
      </Link>
      <Link
        to="/skills"
        search={{ view: "review" }}
        aria-current={view._tag === "Review" ? "page" : undefined}
        className={row}
      >
        <span className="text-text-secondary">
          <SkillsIcon name="review" />
        </span>
        <span className="flex-1 text-ui">{copy.nav.review}</span>
        {waiting > 0 && <span className="text-meta text-label tabular-nums">{formatCount(waiting)}</span>}
      </Link>
      <Link
        to="/skills"
        search={{ view: "changes" }}
        aria-current={view._tag === "Changes" ? "page" : undefined}
        className={row}
      >
        <span className="text-text-secondary">
          <SkillsIcon name="changes" />
        </span>
        <span className="flex-1 text-ui">{copy.nav.changes}</span>
      </Link>
      <NavLabel>{copy.nav.shared}</NavLabel>
      {reads.list.isPending ? (
        <NavSkeleton />
      ) : (
        entries.shared.map((entry) => <ScopeLink key={entry.key} entry={entry} current={open === entry.key} />)
      )}
      <NavLabel>{copy.nav.hobs}</NavLabel>
      {entries.hobs.map((entry) => (
        <ScopeLink key={entry.key} entry={entry} current={open === entry.key} />
      ))}
    </nav>
  );
}
