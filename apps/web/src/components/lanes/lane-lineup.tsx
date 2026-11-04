import type { AgentId } from "@hobbots/domain";
import { HobTile } from "../hob-sprite/hob-sprite.tsx";
import { roomStatusLabel } from "../quest/control-room.ts";
import type { HobLookup } from "../quest/use-work.ts";
import type { Lane } from "./lane-model.ts";
import { messages } from "./messages.ts";

/**
 * The party's sprites in the room's header, one per lane in its order. A sprite goes to its lane:
 * it scrolls the lane into view, flashes it and filters the Workbench to the hob.
 */
export function LaneLineup({
  lanes,
  hobs,
  picked,
  onJump,
}: {
  lanes: ReadonlyArray<Lane>;
  hobs: HobLookup;
  picked: AgentId | null;
  onJump: (hobId: AgentId) => void;
}) {
  return (
    <ul aria-label={messages.lineup} className="m-0 flex list-none items-center gap-1 p-0">
      {lanes.map((lane) => {
        const hob = hobs(lane.hobId);
        const state = roomStatusLabel(lane.status);
        return (
          <li key={lane.hobId}>
            <button
              type="button"
              aria-pressed={picked === lane.hobId}
              aria-label={messages.jump({ name: hob.name, state })}
              title={messages.jumpTitle({ name: hob.name, state })}
              onClick={() => onJump(lane.hobId)}
              className="cursor-pointer rounded-control border-0 bg-transparent p-0.5 hover:bg-hover focus-visible:outline-2 focus-visible:outline-focus-ring aria-pressed:shadow-[inset_0_0_0_2px_var(--color-focus-ring)]"
            >
              <HobTile hob={hob} tile="sm" />
            </button>
          </li>
        );
      })}
    </ul>
  );
}
