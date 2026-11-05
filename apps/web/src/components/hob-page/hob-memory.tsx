import type { Agent, MemoryScope } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { Skeleton } from "@hobbots/ui/components/skeleton";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { memoryNotAnswering, memoryPagesQuery } from "../../api/memory-pages.ts";
import { hobMemoryScopesQuery } from "../../api/memory-saves.ts";
import { formatWhen } from "../../lib/time.ts";
import { memorySearchOf } from "../memory/memory-model.ts";
import { KindTag } from "../memory/memory-parts.tsx";
import { learnedLately, ownCount, readRows } from "./memory-model.ts";
import { messages } from "./messages.ts";

const copy = messages.memory;

const row = "flex items-center gap-3 rounded-control px-3 py-2.5";

/**
 * A hob's Memory tab (ADR 028, #961): how much it remembers and how it uses it, what it learned
 * lately, what it can read, and the ways to its pages in Memory and to what it may remember.
 */
export function HobMemory({ hob }: { hob: Agent }) {
  const own: MemoryScope = { _tag: "Hob", agentId: hob.id };
  const scopes = useQuery(hobMemoryScopesQuery(hob.id));
  const pages = useQuery(memoryPagesQuery(own));
  const failed = scopes.error ?? pages.error;
  const count = ownCount(scopes.data?.scopes);

  return (
    <div className="flex animate-hb-in flex-col gap-4.5 pt-2">
      {failed !== null && (
        <p role="alert" className="m-0 flex items-center gap-3 rounded-card bg-notice px-4 py-3 text-ui text-text">
          <span className="flex-1">{memoryNotAnswering(failed) ? copy.offline({ name: hob.name }) : copy.failed}</span>
          <Button
            variant="outline"
            size="xs"
            onClick={() => {
              void scopes.refetch();
              void pages.refetch();
            }}
          >
            {copy.retry}
          </Button>
        </p>
      )}
      <p className="m-0 text-ui text-text-secondary">
        {count === undefined ? <Skeleton width="48ch" /> : copy.intro({ name: hob.name, count })}
      </p>

      <section aria-label={copy.lately} className="flex flex-col gap-1">
        <h2 className="lbl m-0 pb-1 text-label">{copy.lately}</h2>
        {pages.data === undefined ? (
          <RowsWaiting busy={pages.isPending} />
        ) : pages.data.length === 0 ? (
          <p className="m-0 px-3 text-ui text-text-secondary">{copy.nothingLately}</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
            {learnedLately(pages.data).map((page) => (
              <li key={page.path}>
                <Link
                  to="/memory"
                  search={memorySearchOf({ _tag: "Page", scope: page.scope, path: page.path, version: null })}
                  className={`${row} text-inherit no-underline hover:bg-hover`}
                >
                  <KindTag kind={page.kind} />
                  <span className="min-w-0 flex-1 truncate text-ui text-text-strong">{page.title}</span>
                  <time dateTime={page.updatedAt} className="text-meta whitespace-nowrap text-label">
                    {formatWhen(page.updatedAt)}
                  </time>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label={copy.reads({ name: hob.name })} className="flex flex-col gap-1">
        <h2 className="lbl m-0 pb-1 text-label">{copy.reads({ name: hob.name })}</h2>
        {scopes.data === undefined ? (
          <RowsWaiting busy={scopes.isPending} />
        ) : (
          <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
            {readRows(scopes.data.scopes, hob).map((read) => (
              <li key={read.title} className={row}>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="text-ui text-text-strong">{read.title}</span>
                  <span className="text-meta text-label">{read.hint}</span>
                </span>
                <span className="text-meta text-label tabular-nums">{copy.pages({ count: read.pages })}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="flex flex-wrap gap-2">
        <Button asChild variant="outline">
          <Link to="/memory" search={memorySearchOf({ _tag: "Scope", scope: own, kind: null })}>
            {copy.openInMemory}
          </Link>
        </Button>
        <Button asChild variant="quiet">
          <Link to="/hobs/$hobId/profile" params={{ hobId: hob.id }} search={{ tab: "permissions" }}>
            {copy.mayRemember({ name: hob.name })}
          </Link>
        </Button>
      </div>
    </div>
  );
}

/** Rows in the shape of the list while memory is read, with a line that says so. */
function RowsWaiting({ busy }: { busy: boolean }) {
  return (
    <div aria-busy={busy} className="flex flex-col gap-0.5">
      {["56%", "44%", "50%"].map((width) => (
        <span key={width} aria-hidden className={row}>
          <Skeleton width={width} />
        </span>
      ))}
      {busy && (
        <span role="status" className="px-3 text-detail text-text-secondary">
          {copy.loading}
        </span>
      )}
    </div>
  );
}
