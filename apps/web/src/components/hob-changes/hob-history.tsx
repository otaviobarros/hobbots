import type { Agent } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { Skeleton } from "@hobbots/ui/components/skeleton";
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { hobChangesQuery, markChangesSeen } from "../../api/hob-changes.ts";
import { ChangeList } from "./change-list.tsx";
import { messages } from "./messages.ts";

const copy = messages.history;

/**
 * Notes that you opened the hob's profile, so its Home tile stops saying another hob changed it.
 * Called by the profile whichever tab it opens on.
 */
export const useSeeChanges = (hob: Agent) => {
  const changes = useQuery(hobChangesQuery(hob.id));
  const newest = changes.data?.[0]?.at;
  useEffect(() => {
    if (newest !== undefined) markChangesSeen(hob.id, newest);
  }, [hob.id, newest]);
};

/**
 * The profile's History tab (ADR 034): every configuration version and status change of the hob,
 * newest first, each with who made it, the request behind a hob's change and what it changed, and
 * Revert for the latest version. It follows the hub's events, so a change made elsewhere shows live.
 */
export function HistoryTab({ hob }: { hob: Agent }) {
  const changes = useQuery(hobChangesQuery(hob.id));
  return (
    <div className="flex max-w-form-max flex-col gap-3">
      <span className="text-text-secondary">{copy.intro({ name: hob.name })}</span>
      {changes.isPending && (
        <div role="status" className="flex flex-col gap-2">
          <span className="sr-only">{copy.waiting}</span>
          <Skeleton surface="card" width="60%" />
          <Skeleton surface="card" width="40%" />
        </div>
      )}
      {changes.isError && (
        <p className="m-0 flex flex-wrap items-center gap-3 text-ui text-text-secondary">
          <span role="alert">{copy.failed}</span>
          <Button type="button" variant="chip" size="xs" onClick={() => void changes.refetch()}>
            {copy.retry}
          </Button>
        </p>
      )}
      {changes.isSuccess &&
        (changes.data.length === 0 ? (
          <p className="m-0 text-ui text-text-secondary">{copy.empty}</p>
        ) : (
          <ChangeList changes={changes.data} label={copy.heading} showHob={false} />
        ))}
    </div>
  );
}
