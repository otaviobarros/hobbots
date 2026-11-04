import { Skeleton } from "@hobbots/ui/components/skeleton";
import type { ReactNode } from "react";
import { HubWait, ROW_WIDTHS, SKELETON_ROWS } from "../loading/hub-wait.tsx";

/**
 * The Workbench while its task is read: the header row with Back, a tile, a title and a byline in
 * skeleton, then three rows, where the task lands. Back works at once.
 */
export function BenchSkeleton({ back, onRetry }: { back: ReactNode; onRetry: () => void }) {
  return (
    <div aria-busy="true" className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-6 py-3">
        {back}
        <Skeleton shape="tile" className="size-hob-tile" />
        <span aria-hidden className="flex min-w-[12rem] flex-1 flex-col">
          <span className="font-heading text-title">
            <Skeleton width="22ch" className="max-w-full" />
          </span>
          <span className="text-detail">
            <Skeleton width="30ch" className="max-w-full" />
          </span>
        </span>
      </div>
      <div className="flex flex-col gap-3 px-6 py-6">
        <span aria-hidden className="flex flex-col gap-1 text-ui">
          {SKELETON_ROWS.map((row) => (
            <Skeleton key={row} width={ROW_WIDTHS[row]} className="max-w-full" />
          ))}
        </span>
        <HubWait pending onRetry={onRetry} />
      </div>
    </div>
  );
}
