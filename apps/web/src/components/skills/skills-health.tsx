import type { SkillsList } from "@hobbots/api";
import { Button } from "@hobbots/ui/components/button";
import { cn } from "@hobbots/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { skillHealthQuery } from "../../api/skill-trials.ts";
import { MemoryCard } from "../memory/memory-parts.tsx";
import { messages } from "./messages.ts";
import { type HealthItem, healthItems, loadRows } from "./skills-health-model.ts";
import { folderName, type HobDirectory, skillsSearchOf } from "./skills-model.ts";

const copy = messages;

const row =
  "flex w-full items-start gap-2.5 rounded-control px-1 py-1.5 text-start text-text-strong no-underline hover:bg-hover";

function Dot({ tone }: { tone: "warn" | "info" }) {
  return (
    <span
      aria-hidden
      className={cn("mt-1.5 size-2 flex-none rounded-dot", tone === "warn" ? "bg-lantern" : "bg-label")}
    />
  );
}

/** What `~/.agents/skills` held that was not added, and why. */
function AgentsProblems({ list }: { list: SkillsList }) {
  const where = folderName(list.agentsFolder.path);
  return list.agentsFolder.problems.map((problem) => (
    <li key={problem.folder} className="flex items-start gap-2.5 px-1 py-1.5">
      <Dot tone="warn" />
      <span className="flex min-w-0 flex-col">
        <span className="text-ui text-text-strong">
          {problem.folder === ""
            ? copy.overview.agentsUnreadable({ where })
            : copy.overview.agentsProblem({ folder: problem.folder, where })}
        </span>
        <span className="text-meta text-label">
          {problem.check === null ? problem.message : copy.checks[problem.check]}
        </span>
      </span>
    </li>
  ));
}

function ItemRow({ item }: { item: HealthItem }) {
  return (
    <li>
      <Link to="/skills" search={skillsSearchOf(item.to)} className={row}>
        <Dot tone={item.tone} />
        <span className="flex min-w-0 flex-col">
          <span className="text-ui">{item.title}</span>
          <span className="text-meta text-label">{item.hint}</span>
        </span>
      </Link>
    </li>
  );
}

/** How many lines Worth a look shows before it says how many more there are. */
const SHOWN = 8;

/** A read of the checks that is still on its way, or failed with Try again. */
function Pending({ failed, onRetry }: { failed: boolean; onRetry: () => void }) {
  if (!failed) {
    return (
      <p role="status" className="m-0 text-ui text-text-secondary">
        {copy.health.loading}
      </p>
    );
  }
  return (
    <p role="alert" className="m-0 flex flex-wrap items-center gap-3 text-ui text-text-secondary">
      {copy.health.failed}
      <Button variant="outline" size="xs" onClick={onRetry}>
        {copy.health.retry}
      </Button>
    </p>
  );
}

/**
 * Worth a look (ADR 029, Health checks, #1099): skills `~/.agents/skills` held that were not added,
 * then what the hub's checks found, each a link to where you act on it.
 */
function WorthALookCard({ list, hobs, now }: { list: SkillsList; hobs: HobDirectory; now: Date }) {
  const health = useQuery(skillHealthQuery);
  // Every finding is a click away: past the first few, Show N more lists the rest in place.
  const [all, setAll] = useState(false);
  const items = health.data === undefined ? [] : healthItems(health.data, hobs, now);
  const none = health.data !== undefined && items.length === 0 && list.agentsFolder.problems.length === 0;
  const hidden = items.length - SHOWN;
  return (
    <WorthCard
      list={list}
      after={
        <>
          {hidden > 0 && (
            <Button
              variant="quiet"
              size="xs"
              className="self-start"
              aria-expanded={all}
              onClick={() => setAll((was) => !was)}
            >
              {all ? copy.health.fewer : copy.health.more({ count: hidden })}
            </Button>
          )}
          {none && <p className="m-0 text-ui text-text-secondary">{copy.health.allGood}</p>}
          {health.data === undefined && <Pending failed={health.isError} onRetry={() => void health.refetch()} />}
        </>
      }
    >
      {(all ? items : items.slice(0, SHOWN)).map((item) => (
        <ItemRow key={item.key} item={item} />
      ))}
    </WorthCard>
  );
}

/** Worth a look's card: what `~/.agents/skills` held that was not added, then `children`. */
function WorthCard({ list, children, after }: { list: SkillsList; children?: ReactNode; after?: ReactNode }) {
  return (
    <MemoryCard label={copy.overview.worth}>
      <h3 className="lbl m-0 text-label">{copy.overview.worth}</h3>
      <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
        <AgentsProblems list={list} />
        {children}
      </ul>
      {after}
    </MemoryCard>
  );
}

/** What `~/.agents/skills` held that was not added, and why: on an empty library, which has no checks. */
export function WorthALook({ list }: { list: SkillsList }) {
  return list.agentsFolder.problems.length === 0 ? null : <WorthCard list={list} />;
}

/** What each hob carries: how many skills, and how much of its listing their descriptions take. */
function LoadCard({ hobs }: { hobs: HobDirectory }) {
  const health = useQuery(skillHealthQuery);
  const rows = health.data === undefined ? [] : loadRows(health.data, hobs);
  return (
    <MemoryCard label={copy.health.carries}>
      <h3 className="lbl m-0 text-label">{copy.health.carries}</h3>
      {health.data === undefined && <Pending failed={health.isError} onRetry={() => void health.refetch()} />}
      {health.data !== undefined && rows.length === 0 && (
        <p className="m-0 text-ui text-text-secondary">{copy.health.noHobs}</p>
      )}
      <ul className="m-0 flex list-none flex-col gap-1 p-0">
        {rows.map((one) => (
          <li key={one.agentId}>
            <Link
              to="/skills"
              search={skillsSearchOf(one.to)}
              className="grid grid-cols-[72px_minmax(0,1fr)_80px] items-center gap-2.5 rounded-control px-1 py-1 text-detail text-text-strong no-underline hover:bg-hover"
            >
              <span className="truncate">
                {one.name}
                <span className="sr-only">{copy.health.loadLabel({ count: one.count, percent: one.percent })}</span>
              </span>
              <span aria-hidden className="block h-2 overflow-hidden rounded-dot bg-line">
                <span
                  className={cn("block h-full rounded-dot", one.heavy ? "bg-lantern" : "bg-mint")}
                  style={{ width: `${Math.min(one.percent, 100)}%` }}
                />
              </span>
              <span aria-hidden className="text-end whitespace-nowrap text-label tabular-nums">
                {copy.health.load({ count: one.count, percent: one.percent })}
              </span>
            </Link>
          </li>
        ))}
      </ul>
      <span className="text-meta text-label">{copy.health.loadHint}</span>
    </MemoryCard>
  );
}

/** The Overview's health checks: Worth a look beside What each hob carries. */
export function SkillHealthCards({ list, hobs, now }: { list: SkillsList; hobs: HobDirectory; now: Date }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(280px,1fr))] gap-4">
      <WorthALookCard list={list} hobs={hobs} now={now} />
      <LoadCard hobs={hobs} />
    </div>
  );
}
