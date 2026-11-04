import { HOB_COLORS } from "@hobbots/art/look";
import type { Agent, HistoryDay, HistoryFilter } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@hobbots/ui/components/empty";
import { SegmentedControl, SegmentedControlItem } from "@hobbots/ui/components/segmented-control";
import { cn } from "@hobbots/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { CSSProperties } from "react";
import { useHobHistory } from "../../api/history.ts";
import { agentsQuery } from "../../api/queries.ts";
import { useQuestWork } from "../../api/quest-work.ts";
import { formatTime } from "../../lib/format.ts";
import { ledQuests } from "../../lib/led-quests.ts";
import { questsInProgress } from "../../lib/quest-work.ts";
import { dayLabel, type HistoryMark, type HistoryRow, historyRow } from "./history-model.ts";
import { HISTORY_FILTERS as FILTERS } from "./hob-page-model.ts";
import { messages } from "./messages.ts";

const copy = messages.history;

/** Each mark's colors: done in mint, failed in rose, asks filled with lantern, quests in star, yours in lantern. */
const MARK_CLASS: Record<HistoryMark, string> = {
  done: "text-mint border-[color-mix(in_srgb,var(--color-mint)_50%,transparent)]",
  fail: "text-rose border-[color-mix(in_srgb,var(--color-rose)_50%,transparent)]",
  ask: "bg-lantern border-lantern text-on-lantern",
  quest: "text-star border-[color-mix(in_srgb,var(--color-star)_50%,transparent)]",
  you: "text-lantern border-[color-mix(in_srgb,var(--color-lantern)_50%,transparent)]",
  quiet: "text-text-secondary border-line-2",
};

/**
 * The History tab: what the hob did across all its chats, newest first, a few days at a time. A
 * lead's History also holds its party's work. The filters hide while there is nothing at all.
 */
export function HobHistory({
  hob,
  filter,
  onFilter,
}: {
  hob: Agent;
  filter: HistoryFilter;
  onFilter: (filter: HistoryFilter) => void;
}) {
  const history = useHobHistory(hob.id, filter);
  const pages = history.data?.pages ?? [];
  const days = pages.flatMap((page) => page.days);
  const earlier = pages.at(-1)?.earlierDays ?? 0;
  // While a filter shows nothing, the filters stay so you can go back to Everything.
  const nothingAtAll = filter === "all" && history.isSuccess && days.length === 0;

  return (
    <div className="flex flex-col gap-3.5">
      {!nothingAtAll && <Filters hob={hob} filter={filter} onFilter={onFilter} />}
      <Days hob={hob} filter={filter} history={history} days={days} />
      {history.hasNextPage && earlier > 0 && (
        <button
          type="button"
          disabled={history.isFetchingNextPage}
          onClick={() => void history.fetchNextPage()}
          className="cursor-pointer self-start rounded-control border-0 bg-transparent px-2 py-1.5 text-sm text-link underline decoration-line-2 underline-offset-3 hover:bg-hover disabled:cursor-default disabled:opacity-60"
        >
          {history.isFetchingNextPage ? copy.loadingEarlier : copy.showEarlier({ count: earlier })}
        </button>
      )}
    </div>
  );
}

/** The four filters, and a note on whose work the History holds. */
function Filters({
  hob,
  filter,
  onFilter,
}: {
  hob: Agent;
  filter: HistoryFilter;
  onFilter: (filter: HistoryFilter) => void;
}) {
  const list = useQuery(agentsQuery).data ?? [];
  // A lead's History holds its party's work too, which the note says.
  const { live, finished } = ledQuests(questsInProgress(useQuestWork(list.map((each) => each.id))), hob.id);
  return (
    <div className="flex flex-wrap items-center gap-3">
      <SegmentedControl aria-label={copy.filters.label} size="sm" value={filter} onValueChange={onFilter}>
        {FILTERS.map((each) => (
          <SegmentedControlItem key={each} value={each}>
            {copy.filters[each]}
          </SegmentedControlItem>
        ))}
      </SegmentedControl>
      <span className="text-[13px] leading-[18px] text-label">
        {live.length > 0 || finished > 0 ? copy.noteLead : copy.note({ name: hob.name })}
      </span>
    </div>
  );
}

/** The days read so far, each under its heading, or why there are none. */
function Days({
  hob,
  filter,
  history,
  days,
}: {
  hob: Agent;
  filter: HistoryFilter;
  history: ReturnType<typeof useHobHistory>;
  days: ReadonlyArray<HistoryDay>;
}) {
  const list = useQuery(agentsQuery).data ?? [];
  const hobs = new Map(list.map((each) => [each.id, each]));
  if (history.isPending)
    return (
      <p role="status" className="m-0 text-sm text-label">
        {copy.loading}
      </p>
    );
  if (history.isError && days.length === 0)
    return (
      <div role="alert" className="flex items-center gap-3 text-sm text-rose">
        {copy.failed}
        <Button variant="outline" size="sm" onClick={() => void history.refetch()}>
          {copy.retry}
        </Button>
      </div>
    );
  if (days.length === 0) {
    const all = filter === "all";
    return (
      <Empty surface="card">
        <EmptyMedia variant="icon">
          <ClockIcon />
        </EmptyMedia>
        <EmptyHeader>
          <EmptyTitle>{all ? copy.empty : copy.emptyKind}</EmptyTitle>
          <EmptyDescription>
            {all ? copy.emptyBody({ name: hob.name }) : copy.emptyKindBody({ name: hob.name })}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  const now = new Date();
  return days.map(({ day, events }) => {
    const label = dayLabel(day, now);
    return (
      <section key={day} aria-label={label} className="flex flex-col">
        <h3 className="lbl m-0 flex items-center gap-2 px-1 pb-1.5 text-xs leading-4 text-label after:h-px after:flex-1 after:bg-line">
          {label}
        </h3>
        <ol className="m-0 flex list-none flex-col p-0">
          {events.map((event) => (
            <EventRow key={event.id} row={historyRow(event, hob, hobs)} />
          ))}
        </ol>
      </section>
    );
  });
}

/** One event: its time, its mark on the day's line, what happened, and where it opens. */
function EventRow({ row }: { row: HistoryRow }) {
  return (
    <li className="group/ev relative grid grid-cols-[48px_24px_minmax(0,1fr)_auto] items-start gap-2.5 rounded-control px-3 py-2.5 hover:bg-hover max-[640px]:grid-cols-[40px_24px_minmax(0,1fr)]">
      {/* The day's line runs from one mark to the next. */}
      <span
        aria-hidden
        className="absolute top-9 -bottom-2 left-[81.5px] w-px bg-line-2 group-last/ev:hidden max-[640px]:left-[73.5px]"
      />
      <time dateTime={row.at} className="text-right text-xs leading-6 text-label tabular-nums">
        {formatTime(row.at)}
      </time>
      <span
        aria-hidden
        className={cn(
          "relative z-1 grid size-6 place-items-center rounded-dot border border-solid bg-card text-xs font-bold",
          MARK_CLASS[row.mark],
        )}
      >
        {row.glyph}
      </span>
      <span className="flex min-w-0 flex-col gap-1">
        <span className="text-[15px] leading-[22px] break-words text-text-strong">{row.line}</span>
        {(row.who !== null || row.quest !== null || row.waiting) && (
          <span className="flex flex-wrap items-center gap-1.5">
            {row.who !== null && <Who name={row.who.name} hob={row.who.hob} />}
            {row.quest !== null && <QuestChip goal={row.quest} />}
            {row.waiting && (
              <span className="rounded-tag bg-lantern px-2 py-px text-xs leading-4 font-semibold text-on-lantern">
                {copy.waiting}
              </span>
            )}
          </span>
        )}
      </span>
      <EventActions row={row} />
    </li>
  );
}

function Who({ name, hob }: { name: string; hob: Agent | null }) {
  const tint = hob === null ? "var(--color-lantern)" : HOB_COLORS[hob.lookColor].hat;
  return (
    <span
      style={{ "--hob": tint } as CSSProperties}
      className="inline-flex items-center gap-1.5 text-xs leading-4 font-semibold text-text-secondary before:size-2 before:rounded-[3px] before:bg-(--hob)"
    >
      {name}
    </span>
  );
}

function QuestChip({ goal }: { goal: string }) {
  return (
    <span
      title={goal}
      className="inline-flex max-w-[260px] min-w-0 items-center gap-1 rounded-tag border border-solid border-[color-mix(in_srgb,var(--color-star)_45%,transparent)] px-1.5 py-px text-xs leading-4 text-text-secondary"
    >
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        className="size-3 shrink-0 text-star"
      >
        <path d="M3.5 14V2.5M3.5 3h8l-2 3 2 3h-8" />
      </svg>
      <span className="truncate">{goal}</span>
    </span>
  );
}

const linkClass =
  "rounded-control border border-solid border-line-2 px-2.5 py-1 text-[13px] leading-[18px] whitespace-nowrap text-text no-underline hover:border-lantern hover:text-text-strong";

/** Review opens the Inbox on what waits; Workbench and Chat open where the work happened. */
function EventActions({ row }: { row: HistoryRow }) {
  if (row.review === null && row.bench === null && row.chat === null) return null;
  return (
    <span className="flex flex-wrap items-center justify-end gap-1.5 pt-px max-[640px]:col-start-3 max-[640px]:justify-start">
      {row.review !== null && (
        <Button asChild size="xs">
          <Link to="/inbox" search={{ request: row.review }}>
            {copy.review}
          </Link>
        </Button>
      )}
      {row.bench !== null && (
        <Link
          to="/hobs/$hobId/threads/$threadId"
          params={{ hobId: row.bench.hobId, threadId: row.bench.threadId }}
          search={{
            bench: row.bench.taskId,
            ...(row.bench.attemptId === null ? {} : { attempt: row.bench.attemptId }),
          }}
          className={linkClass}
        >
          {copy.workbench}
        </Link>
      )}
      {row.chat !== null && (
        <Link
          to="/hobs/$hobId/threads/$threadId"
          params={{ hobId: row.chat.hobId, threadId: row.chat.threadId }}
          className={linkClass}
        >
          {copy.chat}
        </Link>
      )}
    </span>
  );
}

function ClockIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="6" />
      <path d="M8 4.5V8l2.5 1.5" />
    </svg>
  );
}
