import { Button } from "@hobbots/ui/components/button";
import { HobTile } from "../hob-sprite/hob-sprite.tsx";
import type { HobLookup } from "../quest/use-work.ts";
import { messages as roomCopy } from "../quest-room/messages.ts";
import { DockChevron, ExpandIcon } from "../quest-room/room-icons.tsx";
import type { ListTab } from "./dock-model.ts";
import { messages } from "./messages.ts";
import type { TabStates } from "./workbench-model.ts";
import { WorkbenchTabs } from "./workbench-tabs.tsx";

type Hob = ReturnType<HobLookup>;

/**
 * The dock's strip (ADR 027): "Workbench", a tab per view with how many records it lists, whose work
 * it shows, and the fold button. Folded, it is all the dock shows; a tab or a lane slides it open.
 */
export function DockBar({
  states,
  counts,
  open,
  filter,
  party,
  onEveryone,
  onFold,
  expanded,
  onExpand,
}: {
  states: TabStates;
  counts: Readonly<Record<ListTab, number>> | null;
  open: boolean;
  /** The hob whose work the dock narrows to, by its lit lane, or null while it shows everyone. */
  filter: Hob | null;
  /** Whether the Quest has more than one lane to pick from. */
  party: boolean;
  onEveryone: () => void;
  onFold: () => void;
  /** Whether the open dock is as tall as the room lets it be. */
  expanded: boolean;
  onExpand: (from: HTMLElement) => void;
}) {
  return (
    <div className="flex min-h-10 items-center gap-2 py-1 ps-4 pe-3">
      <span className="text-detail font-bold text-label">{roomCopy.dock.label}</span>
      {/* In a narrow room the tabs scroll sideways, without a scrollbar, rather than push the fold
          button out. */}
      <div className="flex min-w-0">
        <WorkbenchTabs states={states} counts={counts} />
      </div>
      <span className="ms-auto flex shrink-0 items-center gap-2">
        {filter !== null ? (
          <Button
            variant="chip"
            size="xs"
            title={messages.dock.showEveryone}
            onClick={onEveryone}
            className="max-w-48 min-w-0"
          >
            <HobTile hob={filter} tile="sm" />
            <span className="truncate">{messages.dock.only({ name: filter.name })}</span>
            <span aria-hidden className="text-label">
              ✕
            </span>
            <span className="sr-only">{messages.dock.showEveryone}</span>
          </Button>
        ) : (
          party && (
            <span className="hidden text-detail text-label @min-[640px]/dock:inline">{messages.dock.everyone}</span>
          )
        )}
        {open && (
          <Button
            variant="ghost"
            size="icon"
            aria-pressed={expanded}
            aria-label={roomCopy.dock.expand}
            title={expanded ? roomCopy.dock.shrink : roomCopy.dock.expand}
            onClick={(event) => onExpand(event.currentTarget)}
          >
            <ExpandIcon expanded={expanded} />
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon"
          aria-expanded={open}
          aria-label={open ? roomCopy.dock.fold : roomCopy.dock.open}
          title={open ? roomCopy.dock.fold : roomCopy.dock.open}
          onClick={onFold}
        >
          <DockChevron open={open} />
        </Button>
      </span>
    </div>
  );
}
