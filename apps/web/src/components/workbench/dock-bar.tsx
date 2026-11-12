import { Button } from "@hobbots/ui/components/button";
import { HobTile } from "../hob-sprite/hob-sprite.tsx";
import type { HobLookup } from "../quest/use-work.ts";
import { messages as roomCopy } from "../quest-sheet/messages.ts";
import type { ListTab } from "./dock-model.ts";
import { messages } from "./messages.ts";
import type { TabStates } from "./workbench-model.ts";
import { WorkbenchTabs } from "./workbench-tabs.tsx";

type Hob = ReturnType<HobLookup>;

/**
 * The Workbench's strip (ADR 023): "Workbench", a tab per view with how many records it lists, and
 * whose work it shows.
 */
export function DockBar({
  states,
  counts,
  filter,
  party,
  onEveryone,
}: {
  states: TabStates;
  counts: Readonly<Record<ListTab, number>> | null;
  /** The hob whose work the Workbench narrows to, or null while it shows everyone. */
  filter: Hob | null;
  /** Whether the quest has more than one hob to pick from. */
  party: boolean;
  onEveryone: () => void;
}) {
  return (
    <div className="flex min-h-10 items-center gap-2 py-1 ps-4 pe-3">
      <span className="text-detail font-bold text-label">{roomCopy.dock.label}</span>
      {/* In a narrow column the tabs scroll sideways, without a scrollbar, rather than push the hob's chip out. */}
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
      </span>
    </div>
  );
}
