import type { MemoryPageRead } from "@hobbots/api";
import {
  type MemoryPath,
  type MemoryScope,
  type MemoryVersion,
  type MemoryVersionChanges,
  memoryKindOf,
} from "@hobbots/domain";
import { Skeleton } from "@hobbots/ui/components/skeleton";
import { cn } from "@hobbots/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { memoryVersionQuery } from "../../api/memory-pages.ts";
import { formatAgo, formatMoment } from "../../lib/format.ts";
import { ReplyMarkdown } from "../markdown/reply-markdown.tsx";
import {
  authorName,
  type HistoryRow,
  type HobDirectory,
  historyRows,
  memorySearchOf,
  pageBody,
  pageTitle,
  scopeName,
  shownLines,
} from "./memory-model.ts";
import { KindTag, MemoryCard, PinnedTag } from "./memory-parts.tsx";
import { messages } from "./messages.ts";

const copy = messages;

/** The line under a page's title: who wrote it, and when it last changed. */
const bylineOf = (read: MemoryPageRead, hobs: HobDirectory, now: Date) => {
  const when = formatAgo(read.page.updatedAt, now);
  const first = read.history.at(-1)?.author ?? read.page.author;
  if (first === null) return copy.page.unknownAuthor({ when });
  if (first._tag === "You") return copy.page.written({ when });
  return copy.page.learned({ who: authorName(first, hobs), when });
};

const keptIn = (scope: MemoryScope, hobs: HobDirectory) => {
  switch (scope._tag) {
    case "Hob":
      return copy.page.keptInHob({ name: scopeName(scope, hobs) });
    case "Project":
      return copy.page.keptInProject({ name: scopeName(scope, hobs) });
    case "Everyone":
      return copy.page.keptInAbout;
  }
};

/**
 * A page: its kind, title and body, then beside it where it came from and its History. Show
 * changes on a version lays out what that version changed against the one before it.
 */
export function MemoryRead({
  read,
  version,
  hobs,
  now,
}: {
  read: MemoryPageRead;
  /** The version whose changes show, or null. */
  version: MemoryVersion | null;
  hobs: HobDirectory;
  now: Date;
}) {
  const { page } = read;
  const kind = memoryKindOf(page.path);
  const rows = historyRows(read.history, hobs);
  const shown = rows.find((row) => row.version === version);
  return (
    <div className="flex flex-wrap items-start gap-7">
      <article className="flex min-w-0 max-w-[680px] flex-[1_1_520px] flex-col gap-4">
        <nav aria-label={copy.page.breadcrumb} className="flex items-center gap-1.5 text-detail text-text-secondary">
          <Link
            to="/memory"
            search={memorySearchOf({ _tag: "Scope", scope: page.scope, kind: null })}
            className="text-link"
          >
            {scopeName(page.scope, hobs)}
          </Link>
          <span aria-hidden>›</span>
          <Link to="/memory" search={memorySearchOf({ _tag: "Scope", scope: page.scope, kind })} className="text-link">
            {copy.kinds[kind].group}
          </Link>
        </nav>
        <header className="flex flex-col gap-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <KindTag kind={kind} />
            {page.pinned && <PinnedTag />}
          </div>
          <h2 className="m-0 font-heading text-[28px] leading-[34px] font-bold text-text-strong">
            {pageTitle(page.markdown, page.path)}
          </h2>
          <p className="m-0 text-ui text-text-secondary">{bylineOf(read, hobs, now)}</p>
        </header>
        {shown !== undefined && <VersionChanges scope={page.scope} path={page.path} row={shown} />}
        <ReplyMarkdown content={pageBody(page.markdown)} streaming={false} caret={false} />
      </article>
      <aside aria-label={copy.page.aside} className="flex w-[280px] flex-none flex-col gap-4">
        <MemoryCard label={copy.page.origin}>
          <h3 className="lbl m-0 text-label">{copy.page.origin}</h3>
          <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-detail">
            {page.author !== null && (
              <>
                <dt className="text-label">{page.author._tag === "You" ? copy.page.you : copy.page.hob}</dt>
                <dd className="m-0">{authorName(read.history.at(-1)?.author ?? page.author, hobs)}</dd>
              </>
            )}
            <dt className="text-label">{copy.page.keptIn}</dt>
            <dd className="m-0">{keptIn(page.scope, hobs)}</dd>
          </dl>
        </MemoryCard>
        <MemoryCard label={copy.page.history}>
          <h3 className="lbl m-0 text-label">{copy.page.history}</h3>
          <ol className="m-0 flex list-none flex-col gap-2.5 p-0">
            {rows.map((row) => (
              <HistoryEntry
                key={row.version}
                row={row}
                scope={page.scope}
                path={page.path}
                open={row.version === version}
              />
            ))}
          </ol>
        </MemoryCard>
      </aside>
    </div>
  );
}

function HistoryEntry({
  row,
  scope,
  path,
  open,
}: {
  row: HistoryRow;
  scope: MemoryScope;
  path: MemoryPath;
  open: boolean;
}) {
  return (
    <li className="flex items-start gap-2 text-detail">
      <span className="flex min-w-0 flex-1 flex-col">
        <span>{row.what}</span>
        <span className="text-label">{formatMoment(row.at)}</span>
      </span>
      <Link
        to="/memory"
        search={memorySearchOf({ _tag: "Page", scope, path, version: open ? null : row.version })}
        activeOptions={{ exact: true }}
        aria-expanded={open}
        className="rounded-control px-2 py-0.5 text-meta text-text-secondary no-underline hover:bg-hover hover:text-text-strong"
      >
        {open ? copy.page.hideChanges : copy.page.showChanges}
      </Link>
    </li>
  );
}

/** What one version changed: the lines it added and removed, against the version it replaced. */
function VersionChanges({ scope, path, row }: { scope: MemoryScope; path: MemoryPath; row: HistoryRow }) {
  const changes = useQuery(memoryVersionQuery(scope, path, row.version));
  return (
    <section
      aria-label={copy.page.changesIn({ when: formatMoment(row.at) })}
      className="overflow-hidden rounded-card border border-line-2 bg-card"
    >
      <div className="flex items-center gap-2 border-b border-line bg-deep px-3 py-2.5 text-detail">
        {copy.page.changesIn({ when: formatMoment(row.at) })}
      </div>
      {changes.isError && <p className="m-0 px-3 py-2 text-ui text-text-secondary">{copy.page.diffFailed}</p>}
      {changes.isPending && (
        <div role="status" className="flex flex-col gap-2 px-3 py-2">
          <span className="sr-only">{copy.page.diffLoading}</span>
          <Skeleton surface="card" width="60%" />
          <Skeleton surface="card" width="40%" />
        </div>
      )}
      {changes.isSuccess && <DiffLines changes={changes.data} />}
    </section>
  );
}

function DiffLines({ changes }: { changes: MemoryVersionChanges }) {
  return (
    <div>
      {changes.first && <p className="m-0 px-3 pt-2 text-meta text-label">{copy.page.firstVersion}</p>}
      <ul className="m-0 list-none p-0 py-1">
        {shownLines(changes.lines).map((line, at) => (
          <li
            // biome-ignore lint/suspicious/noArrayIndexKey: a diff's lines have no identity but their place (STD-REACT-020).
            key={at}
            className={cn(
              "flex gap-2.5 px-3 py-1.5 text-ui",
              line.op === "add" && "bg-[color-mix(in_srgb,var(--color-mint)_12%,transparent)] text-text-strong",
              line.op === "remove" &&
                "bg-[color-mix(in_srgb,var(--color-rose)_10%,transparent)] text-text-secondary line-through",
              line.op === "same" && "text-text-secondary",
            )}
          >
            <span aria-hidden className={cn("w-2.5 flex-none", line.op === "add" ? "text-mint" : "text-rose")}>
              {line.op === "add" ? "+" : line.op === "remove" ? "−" : " "}
            </span>
            <span className="sr-only">
              {line.op === "add" ? `${copy.page.added}: ` : line.op === "remove" ? `${copy.page.removed}: ` : ""}
            </span>
            <span className="min-w-0 break-words">{line.text}</span>
          </li>
        ))}
      </ul>
      {changes.cut && <p className="m-0 px-3 pb-2 text-meta text-label">{copy.page.diffCut}</p>}
    </div>
  );
}
