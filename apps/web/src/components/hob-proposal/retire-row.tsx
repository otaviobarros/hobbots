import type { HobProposalRow } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { useQuery } from "@tanstack/react-query";
import { useActivity } from "../../api/activity.ts";
import { openWorkQuery, threadsQuery } from "../../api/queries.ts";
import { OpenWorkList } from "../hob-profile/retire-parts.tsx";
import { messages } from "./messages.ts";

const copy = messages.retire;

/**
 * What a retire row needs read before you can allow it, as Retire on the profile reads it: the hob's
 * running replies and its open work. `reading` until both are in, `failed` when either could not be
 * read, so the row is never allowed on a list that only looks empty.
 */
export function useRetireReview(row: HobProposalRow, enabled: boolean) {
  const threads = useQuery({ ...threadsQuery(row.hobId), enabled });
  const work = useQuery({ ...openWorkQuery(row.hobId, null), enabled });
  const activity = useActivity();
  const running = (threads.data ?? []).filter((thread) => activity[thread.id] !== undefined).map((t) => t.title);
  const state = threads.isError || work.isError ? "failed" : threads.isSuccess && work.isSuccess ? "read" : "reading";
  return {
    state,
    running,
    work: work.data,
    retry: () => {
      if (threads.isError) void threads.refetch();
      if (work.isError) void work.refetch();
    },
  } as const;
}

export type RetireReview = ReturnType<typeof useRetireReview>;

/**
 * A hob to retire: while the row waits, what it has running and open, as Retire lists it; then what
 * stays, and what the manager chose for its running replies.
 */
export function RetireRow({ row, review }: { row: HobProposalRow; review: RetireReview }) {
  return (
    <div className="flex flex-col gap-1.5">
      <b className="text-ui text-text-strong">{row.label}</b>
      {row.state === "pending" && <WhatIsOpen hob={row.label} review={review} />}
      <span className="text-detail text-text-secondary">{copy.owns({ hob: row.label })}</span>
      <span className="text-detail text-text-secondary">{row.runningReplies === "stop" ? copy.stop : copy.finish}</span>
    </div>
  );
}

/** What the hob has running and open, once read; while it is read, or why it could not be, with Try again. */
function WhatIsOpen({ hob, review }: { hob: string; review: RetireReview }) {
  if (review.state === "reading") {
    return (
      <span role="status" className="text-detail text-text-secondary">
        {copy.reading({ hob })}
      </span>
    );
  }
  if (review.state === "failed") {
    return (
      <span className="flex flex-wrap items-center gap-2">
        <span role="alert" className="text-detail text-rose">
          {copy.unread({ hob })}
        </span>
        <Button size="sm" variant="outline" onClick={review.retry}>
          {copy.tryAgain}
        </Button>
      </span>
    );
  }
  const work = review.work;
  const open = (work?.tasks.length ?? 0) + (work?.approvals.length ?? 0) + (work?.backpackItems.length ?? 0);
  return review.running.length === 0 && open === 0 ? (
    <span className="text-detail text-text-secondary">{copy.nothingOpen({ hob })}</span>
  ) : (
    <OpenWorkList running={review.running} work={work} blockedTaker={null} />
  );
}
