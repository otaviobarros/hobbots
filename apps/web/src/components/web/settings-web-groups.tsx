import { Button } from "@hobbots/ui/components/button";
import { useQuery } from "@tanstack/react-query";
import { Fragment } from "react";
import { pageCacheQuery, useClearPageCache } from "../../api/web.ts";
import { SettingsGroup } from "../settings/settings-group.tsx";
import { messages } from "./messages.ts";
import { ReadFailed } from "./read-failed.tsx";

// Settings › Web's groups that save nothing of yours: what leaves your computer, and the page cache.

const copy = messages.settings;

const LEAVES = ["search", "page", "never", "robots", "kept"] as const;

/** What leaves your computer when a hob searches or reads a page, and what stays. */
export function LeavesGroup() {
  return (
    <SettingsGroup label={copy.leaves}>
      <dl className="m-0 grid grid-cols-1 overflow-hidden rounded-card bg-card sm:grid-cols-[minmax(140px,auto)_1fr]">
        {LEAVES.map((key) => (
          <Fragment key={key}>
            <dt className="border-line px-4 pt-3 font-bold text-text-strong sm:border-t sm:py-3 sm:first-of-type:border-t-0">
              {copy.leave[key].label}
            </dt>
            <dd className="m-0 border-line px-4 pb-3 text-ui text-text sm:border-t sm:py-3 sm:[&:nth-of-type(1)]:border-t-0">
              {copy.leave[key].text}
            </dd>
          </Fragment>
        ))}
      </dl>
    </SettingsGroup>
  );
}

/** The pages the hub holds for 15 minutes, with Clear now. */
export function CacheGroup() {
  const cache = useQuery(pageCacheQuery);
  const clear = useClearPageCache();
  const held = cache.data;
  return (
    <SettingsGroup label={copy.cache}>
      <div className="flex items-center gap-3 rounded-control bg-card px-3.5 py-2.5">
        <span className="flex min-w-0 flex-1 flex-col">
          {cache.isError ? (
            <ReadFailed text={copy.cacheFailed} onRetry={() => void cache.refetch()} />
          ) : (
            <span role={held === undefined ? "status" : undefined} className="text-text-strong">
              {held === undefined ? messages.reading : copy.cacheHeld({ count: held.pages, bytes: held.bytes })}
            </span>
          )}
          <span className="text-detail text-text-secondary">{copy.cacheNote}</span>
        </span>
        <Button
          variant="outline"
          disabled={held === undefined || held.pages === 0}
          aria-disabled={clear.isPending}
          onClick={() => !clear.isPending && clear.mutate()}
        >
          {clear.isPending ? copy.clearing : copy.clear}
        </Button>
      </div>
      {clear.isError && (
        <p role="alert" className="m-0 text-ui text-rose">
          {copy.clearFailed}
        </p>
      )}
    </SettingsGroup>
  );
}
