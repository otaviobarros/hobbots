import { Button } from "@hobbots/ui/components/button";
import { HobTile } from "../hob-sprite/hob-sprite.tsx";
import type { HobLookup } from "../quest/use-work.ts";
import { messages as roomCopy } from "../quest-room/messages.ts";
import { DockChevron } from "../quest-room/room-icons.tsx";
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
}: {
  states: TabStates;
  counts: Readonly<Record<ListTab, number>> | null;
  open: boolean;
  /**
   * Whose work the dock narrows to, by the lit lane's hob and the name its chip shows: the hob's,
   * or the one Task's shown alone. Null while the dock shows everyone.
   */
  filter: { readonly hob: Hob; readonly name: string } | null;
  /** Whether the Quest has more than one lane to pick from. */
  party: boolean;
  onEveryone: () => void;
  onFold: () => void;
}) {
  return (
    <div className="flex min-h-10 items-center gap-2 py-1 ps-4 pe-3">
      <span className="text-detail font-bold text-label">{roomCopy.dock.label}</span>
      {/* In a narrow room the tabs scroll sideways rather than push the fold button out. */}
      <div className="min-w-0 overflow-x-auto">
        <WorkbenchTabs states={states} counts={counts} />
      </div>
      <span className="ms-auto flex shrink-0 items-center gap-2">
        {filter !== null ? (
          <Button variant="chip" size="xs" title={messages.dock.showEveryone} onClick={onEveryone}>
            <HobTile hob={filter.hob} tile="sm" />
            {messages.dock.only({ name: filter.name })}
            <span aria-hidden className="text-label">
              ✕
            </span>
            <span className="sr-only">{messages.dock.showEveryone}</span>
          </Button>
        ) : (
          party && (
            <span className="hidden text-meta text-label @min-[640px]/dock:inline">{messages.dock.everyone}</span>
          )
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
