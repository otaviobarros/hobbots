import { cn } from "@hobbots/ui/lib/utils";
import { Link } from "@tanstack/react-router";
import { formatCount } from "../../lib/format.ts";
import { NeedsTray } from "../needs-tray/needs-tray.tsx";
import { TRAY_HOST } from "../needs-tray/tray-focus.ts";
import { messages } from "./messages.ts";
import { useHomeNeeds } from "./use-home-needs.ts";

const copy = messages.needsYou;

const moreLink =
  "inline-flex items-center gap-1 rounded-control px-2 py-[3px] text-detail text-link no-underline hover:bg-hover";

/**
 * Needs you, under the scene: the same tray as in the chat, holding what waits on you in every
 * chat, or an all-clear line once nothing does. Deciding here records the Inbox as where.
 */
export function NeedsYou() {
  const { entries, ready } = useHomeNeeds();
  return (
    <section {...TRAY_HOST} aria-label={copy.title} className="flex flex-col gap-2.5">
      <div className="flex items-center gap-2">
        <span
          aria-hidden
          className="size-2 rounded-dot bg-lantern shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-lantern)_22%,transparent)]"
        />
        <h2 className="lbl m-0 text-lantern">{copy.title}</h2>
        {entries.length > 0 && (
          <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-tag bg-line px-1.5 text-meta font-semibold text-text-secondary">
            {formatCount(entries.length)}
          </span>
        )}
        <Link to="/inbox" search={{ tab: "needs" }} className={cn("ms-auto", moreLink)}>
          {copy.openInbox}
          <span aria-hidden>→</span>
        </Link>
      </div>
      <NeedsTray entries={entries} via="inbox" />
      {ready && entries.length === 0 && <AllClear />}
    </section>
  );
}

function AllClear() {
  return (
    <div className="flex animate-hb-in items-center gap-3.5 rounded-card bg-card px-4 py-3.5 ring-1 ring-line ring-inset">
      <span
        aria-hidden
        className="flex size-9 shrink-0 items-center justify-center rounded-dot bg-[color-mix(in_srgb,var(--color-mint)_18%,transparent)] text-mint"
      >
        <svg aria-hidden viewBox="0 0 16 16" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M3 8.5 6.5 12 13 4.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="font-semibold text-text-strong">{copy.clear}</span>
        <span className="text-ui text-text-secondary">{copy.clearLine}</span>
      </span>
      <Link to="/inbox" search={{ tab: "history" }} className={moreLink}>
        {copy.history}
      </Link>
    </div>
  );
}
