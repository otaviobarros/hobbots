import { HOB_COLORS } from "@hobbots/art/look";
import type { Agent, Thread } from "@hobbots/domain";
import { Badge } from "@hobbots/ui/components/badge";
import { Button } from "@hobbots/ui/components/button";
import { PopoverClose, PopoverContent } from "@hobbots/ui/components/popover";
import { cn } from "@hobbots/ui/lib/utils";
import { Link } from "@tanstack/react-router";
import type { CSSProperties } from "react";
import { useActivity } from "../../api/activity.ts";
import { useBackpack } from "../../api/backpack.ts";
import { useBlockers } from "../../api/blockers.ts";
import type { HobState } from "../../lib/hob-state.ts";
import { waitingCount, waitingView } from "../backpack/backpack-model.ts";
import { useOpenItem } from "../backpack/use-open-item.ts";
import { WaitingList } from "../backpack/waiting-list.tsx";
import { doingOf, stateTag } from "../hob-page/hob-page-model.ts";
import { useNeedLine } from "../hob-page/use-need-line.ts";
import { HobSprite } from "../hob-sprite/hob-sprite.tsx";
import { useNow } from "../inbox/use-now.ts";
import { useHobLookup } from "../quest/use-work.ts";
import { HobQuestWork } from "../quest-work/quest-work.tsx";
import { messages } from "./messages.ts";

const copy = messages.card;

// The hob's hat color (`--hob`) tints the top of the card and its pixel ground strip, mixed with
// theme tokens so it reads in every theme.
const doorStyle = (hob: Agent): CSSProperties =>
  ({
    "--hob": HOB_COLORS[hob.lookColor].hat,
    backgroundImage:
      "linear-gradient(180deg, color-mix(in srgb, var(--hob) 32%, var(--color-card)) 0%, color-mix(in srgb, var(--hob) 12%, var(--color-card)) 100%)",
  }) as CSSProperties;

const stripStyle: CSSProperties = {
  backgroundImage:
    "repeating-linear-gradient(90deg, color-mix(in srgb, var(--hob) 50%, var(--color-deep)) 0 6px, color-mix(in srgb, var(--hob) 36%, var(--color-deep)) 6px 12px)",
};

/** The dot before what the hob is doing: lantern when it needs you, mint while it works. */
const DOT: Record<"needs-you" | "live" | "quiet", string> = {
  "needs-you": "bg-lantern",
  live: "bg-mint",
  quiet: "bg-label",
};

/**
 * A hob's card, beside the sidebar: its portrait on its ground, its state, what it is doing, its
 * backpack, and the way to its page and profile. Esc, a click outside or the hob's tile closes it.
 */
export function HobCard({ hob, state, threads }: { hob: Agent; state: HobState; threads: ReadonlyArray<Thread> }) {
  const tag = stateTag(state);
  const doing = doingOf(state, threads, useActivity(), useNeedLine(hob.id));
  return (
    <PopoverContent
      side="right"
      align="start"
      sideOffset={12}
      aria-label={hob.name}
      className="flex flex-col overflow-hidden border-(length:--edge) p-0 shadow-menu"
    >
      <div className="relative flex h-[84px] items-end px-4" style={doorStyle(hob)}>
        <HobSprite hob={hob} size={64} className="z-[1] -mb-0.5" />
        <div aria-hidden className="absolute inset-x-0 bottom-0 h-1.5" style={stripStyle} />
        <Badge variant={tag.variant} className="absolute top-3 end-12">
          <span aria-hidden data-slot="badge-glyph">
            {tag.glyph}
          </span>
          {tag.word}
        </Badge>
        <PopoverClose asChild>
          <Button variant="ghost" size="icon" aria-label={copy.close} className="absolute top-2 end-2 size-hit-min">
            <span aria-hidden>×</span>
          </Button>
        </PopoverClose>
      </div>
      <div className="flex flex-col gap-3 px-4 pt-3 pb-4">
        <span className="flex min-w-0 flex-col">
          <PopoverClose asChild>
            <Link
              to="/hobs/$hobId"
              params={{ hobId: hob.id }}
              className="truncate font-heading text-[20px] leading-[26px] font-(--heading-weight) text-text-strong no-underline hover:underline hover:decoration-lantern"
            >
              {hob.name}
            </Link>
          </PopoverClose>
          <span className="truncate text-detail text-text-secondary">{hob.roleTitle}</span>
        </span>
        {doing && (
          <span className="flex min-w-0 items-center gap-2 text-sm text-text">
            <span aria-hidden className={cn("size-2 flex-none rounded-dot", DOT[doing.kind])} />
            <span className="truncate">{doing.text}</span>
          </span>
        )}
        <HobQuestWork hob={hob} />
        <CardBackpack hob={hob} />
        <div className="flex gap-2">
          {/* Each way out closes the card, so it never stays open over the page it opened. */}
          <PopoverClose asChild>
            <Button asChild variant="outline" size="sm" className="flex-1">
              <Link to="/hobs/$hobId" params={{ hobId: hob.id }}>
                {copy.openPage}
              </Link>
            </Button>
          </PopoverClose>
          <PopoverClose asChild>
            <Button asChild variant="ghost" size="sm">
              <Link to="/hobs/$hobId/profile" params={{ hobId: hob.id }}>
                {copy.profile}
              </Link>
            </Button>
          </PopoverClose>
        </div>
      </div>
    </PopoverContent>
  );
}

/** What the hob still has to deal with (ADR 019): four items at most, never badged. */
function CardBackpack({ hob }: { hob: Agent }) {
  const now = useNow();
  const view = waitingView(useBackpack().items, useBlockers(), { kind: "hob", hobId: hob.id }, now);
  const hobs = useHobLookup();
  const openItem = useOpenItem();
  const count = waitingCount(view);
  const empty = view.open.length + view.handled.length === 0;
  return (
    <section aria-label={copy.backpack} className="cut flex flex-col gap-2 bg-deep px-3.5 py-3">
      <span className="flex items-center gap-2">
        <span className="lbl flex-1 text-xs text-label">{copy.backpack}</span>
        <span className="min-w-5 rounded-tag bg-line px-1.5 text-center text-meta font-semibold text-text-secondary">
          {count}
        </span>
      </span>
      {empty ? (
        <span className="text-detail text-label">{copy.backpackEmpty}</span>
      ) : (
        <WaitingList
          view={view}
          hobs={hobs}
          now={now}
          owners={false}
          limit={4}
          onOpen={(item) => void openItem(item)}
          label={copy.backpackList({ name: hob.name })}
        />
      )}
    </section>
  );
}
