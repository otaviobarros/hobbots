import { Skeleton } from "@hobbots/ui/components/skeleton";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { ChatsLoading } from "./hob-chats.tsx";
import { messages } from "./messages.ts";

const copy = messages;

/** Your hobs / the hob's name, above its hero. The name is a skeleton until the hob is read. */
export function HobCrumbs({ name }: { name: string | undefined }) {
  let current: ReactNode = <Skeleton width="8ch" />;
  if (name !== undefined) {
    current = (
      <span aria-current="page" title={name} className="truncate text-text-strong">
        {name}
      </span>
    );
  }
  return (
    <nav
      aria-label={copy.crumbs}
      className="-mb-2 flex min-w-0 items-center gap-1.5 text-detail leading-[18px] text-label"
    >
      <Link
        to="/hobs"
        className="rounded-control px-1 py-0.5 text-text-secondary no-underline hover:bg-hover hover:text-text-strong"
      >
        {copy.yourHobs}
      </Link>
      <span aria-hidden className="text-label">
        /
      </span>
      {current}
    </nav>
  );
}

/**
 * A hob's page before its hob is read, as on a first load over Tailscale: the crumbs, the hero's
 * frame with a tile and a name and role in skeleton, and three chat rows. Nothing moves when the
 * hob lands, and after 10 seconds the page offers Try again.
 */
export function HobPageSkeleton({ onRetry }: { onRetry: () => void }) {
  return (
    <div aria-busy="true" className="mx-auto flex w-full max-w-page-max flex-col gap-6 px-6 pt-5 pb-12">
      <HobCrumbs name={undefined} />
      <section aria-hidden className="cut relative overflow-hidden bg-card px-6 pt-6">
        <div className="relative flex flex-wrap items-end gap-5">
          <span className="flex h-[120px] w-[112px] flex-none items-end justify-center pb-1.5">
            <Skeleton shape="tile" surface="card" className="size-24" />
          </span>
          <div className="flex min-w-0 flex-[1_1_340px] flex-col gap-1.5 pb-[18px]">
            <span className="flex min-w-0 items-center gap-2.5 font-(family-name:--font-heading) text-display">
              <Skeleton surface="card" width="9ch" />
              <Skeleton shape="block" surface="card" width="8ch" />
            </span>
            <span className="text-[15px]">
              <Skeleton surface="card" width="28ch" className="max-w-full" />
            </span>
          </div>
        </div>
        <div className="relative -mx-6 h-2.5 bg-line-2" />
      </section>
      <ChatsLoading onRetry={onRetry} />
    </div>
  );
}
