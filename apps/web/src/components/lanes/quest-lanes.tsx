import type { AgentId } from "@hobbots/domain";
import type { HobLookup } from "../quest/use-work.ts";
import type { Lane as LaneData, LaneNode, LaneRoom } from "./lane-model.ts";
import { type LaneSlots, LaneView } from "./lane-view.tsx";
import { messages } from "./messages.ts";
import type { LaneReads } from "./use-lane-room.ts";

interface Shared {
  hobs: HobLookup;
  /** The hob whose lane filters the Workbench, or null for everyone. */
  picked: AgentId | null;
  onPick: (hobId: AgentId | null) => void;
  /** The lane the lineup last jumped to, which flashes once. */
  flashing: AgentId | null;
  onFlashed: () => void;
  /** What the room puts in each lane: its menu, its tries and its Tasks' cards. */
  slots?: (lane: LaneData) => LaneSlots;
  /** Where the reads of each hob's records stand. */
  reads?: (hobId: AgentId) => LaneReads;
  /** Show the exact marks in place of everyday words. */
  technical?: boolean;
  /** The Quest has ended, so each lane folds to its results. */
  finished?: boolean;
}

function Lane({ node, ...shared }: Shared & { node: LaneNode }) {
  const { hobs, picked, flashing } = shared;
  const id = node.lane.hobId;
  return (
    <LaneView
      lane={node.lane}
      hobs={hobs}
      picked={picked === id}
      flashing={flashing === id}
      onPick={shared.onPick}
      onFlashed={shared.onFlashed}
      slots={shared.slots?.(node.lane) ?? {}}
      reads={shared.reads?.(id)}
      technical={shared.technical ?? false}
      finished={shared.finished ?? false}
    />
  );
}

const laneCount = (node: LaneNode): number => 1 + node.party.reduce((sum, member) => sum + laneCount(member), 0);

/** A member that leads its own Quest: its lane and its party's, under "Rook's party". */
function Party({ node, ...shared }: Shared & { node: LaneNode }) {
  const name = shared.hobs(node.lane.hobId).name;
  return (
    <section
      aria-label={messages.party({ name })}
      // A party takes the room of the lanes in it, so its lanes are as wide as the others.
      style={{ flexGrow: laneCount(node) }}
      className="flex min-w-min shrink-0 basis-0 flex-col gap-1.5 rounded-card border-(length:--edge) border-dashed border-line-2 px-2 pt-1.5 pb-2"
    >
      <span aria-hidden className="px-1 font-heading text-meta font-(--heading-weight) text-label uppercase">
        {messages.party({ name })}
      </span>
      <div className="flex min-h-0 flex-1 gap-2.5">
        <Lane node={node} {...shared} />
        {node.party.map((member) => (
          <Node key={member.lane.hobId} node={member} {...shared} />
        ))}
      </div>
    </section>
  );
}

function Node({ node, ...shared }: Shared & { node: LaneNode }) {
  return node.party.length > 0 ? <Party node={node} {...shared} /> : <Lane node={node} {...shared} />;
}

/**
 * The Quest room's lanes, side by side (ADR 027): the lead's, then one per member, a member that
 * leads its own Quest grouped with its party. Lanes keep a minimum width and the row scrolls
 * sideways once they do not fit.
 */
export function QuestLanes({ room, ...shared }: Shared & { room: LaneRoom }) {
  return (
    <section
      aria-label={messages.region}
      className="flex min-h-0 flex-1 items-stretch gap-3 overflow-x-auto px-5 py-3.5"
    >
      {room.lanes.map((node) => (
        <Node key={node.lane.hobId} node={node} {...shared} />
      ))}
    </section>
  );
}
