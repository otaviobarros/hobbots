import type { AgentId } from "@hobbots/domain";
import { cn } from "@hobbots/ui/lib/utils";
import type { HobState } from "../../lib/hob-state.ts";
import { HobSprite } from "../hob-sprite/hob-sprite.tsx";
import { type RoomStatus, roomStatusLabel, roomTone } from "../quest/control-room.ts";
import { StatusTag } from "../quest/status-dot.tsx";
import type { HobLookup } from "../quest/use-work.ts";
import { LaneItemRow } from "./lane-items.tsx";
import { type Lane, type LaneRole, laneDomId } from "./lane-model.ts";
import { messages } from "./messages.ts";

/** How the hob's sprite moves for where its Task stands: working hops, waiting dozes. */
const MOOD: Readonly<Record<RoomStatus, HobState>> = {
  running: "working",
  waiting: "asleep",
  blocked: "waiting",
  "needs-you": "needs-you",
  failed: "failed",
  done: "idle",
  cancelling: "waiting",
  cancelled: "idle",
  unresolved: "waiting",
};

const roleText = (role: LaneRole, hobs: HobLookup): string | null =>
  role.kind === "lead"
    ? messages.role.lead
    : role.kind === "leads"
      ? messages.role.leads({ names: messages.names(role.members.map((id) => hobs(id).name)) })
      : null;

/** The lane's frame: lit in focus while it filters the Workbench, lantern while it needs you, rose once it failed. */
const frame = (lane: Lane, picked: boolean) =>
  picked
    ? "border-focus-ring"
    : lane.status === "needs-you"
      ? "border-lantern"
      : lane.status === "failed"
        ? "border-rose"
        : "border-transparent";

/**
 * One hob's lane (ADR 027): a header with its sprite in its mood, name, role, Task and where it
 * stands, then what it did in order. Clicking the header filters the Workbench to the hob, and
 * clicking it again shows everyone.
 */
export function LaneView({
  lane,
  hobs,
  picked,
  flashing,
  onPick,
  onFlashed,
}: {
  lane: Lane;
  hobs: HobLookup;
  picked: boolean;
  /** The lineup jumped here: the lane flashes once. */
  flashing: boolean;
  onPick: (hobId: AgentId | null) => void;
  onFlashed: () => void;
}) {
  const hob = hobs(lane.hobId);
  const role = roleText(lane.role, hobs);
  return (
    <section
      id={laneDomId(lane.hobId)}
      aria-label={messages.lane({ name: hob.name })}
      onAnimationEnd={flashing ? onFlashed : undefined}
      className={cn(
        "flex min-h-0 w-0 min-w-lane flex-1 flex-col rounded-card border-(length:--edge) border-solid bg-panel",
        frame(lane, picked),
        flashing && "animate-hb-flash",
      )}
    >
      <button
        type="button"
        aria-pressed={picked}
        aria-label={messages.show({ name: hob.name })}
        onClick={() => onPick(picked ? null : lane.hobId)}
        className="flex cursor-pointer items-center gap-2.5 rounded-t-card border-0 bg-transparent px-3 py-2.5 text-start text-text-strong hover:bg-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus-ring"
      >
        <HobSprite hob={hob} size={32} state={MOOD[lane.status]} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate font-heading text-body font-(--heading-weight)">
            {hob.name}
            {role !== null && <span className="ms-1.5 font-sans text-meta font-normal text-label">{role}</span>}
          </span>
          <span className="truncate text-detail text-text-secondary" title={lane.title}>
            {lane.title}
          </span>
        </span>
        <StatusTag status={roomTone(lane.status)}>{roomStatusLabel(lane.status)}</StatusTag>
      </button>
      <ol
        aria-label={messages.did({ name: hob.name })}
        className="m-0 flex min-h-0 flex-1 list-none flex-col gap-1.5 overflow-y-auto px-3 pt-1 pb-3"
      >
        {lane.items.map((item) => (
          <LaneItemRow key={item.key} item={item} hobs={hobs} />
        ))}
      </ol>
    </section>
  );
}
