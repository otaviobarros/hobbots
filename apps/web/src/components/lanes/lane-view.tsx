import type { AgentId } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { cn } from "@hobbots/ui/lib/utils";
import { type ReactNode, useState } from "react";
import type { HobState } from "../../lib/hob-state.ts";
import { HobSprite } from "../hob-sprite/hob-sprite.tsx";
import { HubWait } from "../loading/hub-wait.tsx";
import { type RoomStatus, roomStatusLabel, roomTone } from "../quest/control-room.ts";
import { StatusTag } from "../quest/status-dot.tsx";
import type { HobLookup } from "../quest/use-work.ts";
import { Said } from "../said/said.tsx";
import { LANE, LANE_HEAD } from "./lane-focus.ts";
import { LaneItemRow } from "./lane-items.tsx";
import { type Lane, type LaneRole, laneDomId } from "./lane-model.ts";
import { messages } from "./messages.ts";
import type { LaneReads } from "./use-lane-room.ts";

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
      ? role.members.length === 0
        ? messages.role.leadsQuest
        : messages.role.leads({ names: messages.names(role.members.map((id) => hobs(id).name)) })
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

/** What the room puts in a lane beside what the lane draws itself. */
export interface LaneSlots {
  /** Controls beside the header, such as the lane's menu. */
  readonly actions?: ReactNode;
  /** A row under the header, such as the Task's tries. */
  readonly tries?: ReactNode;
  /** What closes the lane, after what the hob did: its Tasks' cards with their controls. */
  readonly cards?: ReactNode;
}

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
  slots = {},
  reads,
  technical = false,
  finished = false,
}: {
  lane: Lane;
  hobs: HobLookup;
  picked: boolean;
  /** The lineup jumped here: the lane flashes once. */
  flashing: boolean;
  onPick: (hobId: AgentId | null) => void;
  onFlashed: () => void;
  slots?: LaneSlots;
  /** Where the reads of the hob's records stand; with none, the lane shows only the tree. */
  reads?: LaneReads | undefined;
  /** Show the exact marks: commands, the files read and every refusal, in place of everyday words. */
  technical?: boolean;
  /** The Quest has ended: in everyday words the lane folds to its results until it is opened. */
  finished?: boolean;
}) {
  const hob = hobs(lane.hobId);
  const role = roleText(lane.role, hobs);
  const [opened, setOpened] = useState(false);
  const all = technical ? lane.items : lane.plain;
  const results = all.filter((item) => item.kind === "result");
  const folded = finished && !technical && !opened && results.length > 0 && results.length < all.length;
  const shown = folded ? results : all;
  return (
    <section
      id={laneDomId(lane.hobId)}
      {...LANE}
      aria-label={messages.lane({ name: hob.name })}
      onAnimationEnd={flashing ? onFlashed : undefined}
      className={cn(
        "flex min-h-0 w-0 min-w-lane flex-1 flex-col rounded-card border-(length:--edge) border-solid bg-panel",
        frame(lane, picked),
        flashing && "animate-hb-flash",
      )}
    >
      <div className="flex items-center gap-1 pe-2">
        <button
          type="button"
          {...LANE_HEAD}
          aria-pressed={picked}
          onClick={() => onPick(picked ? null : lane.hobId)}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 rounded-t-card border-0 bg-transparent px-3 py-2.5 text-start text-text-strong hover:bg-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus-ring"
        >
          <HobSprite hob={hob} size={32} state={MOOD[lane.status]} />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate font-heading text-body font-(--heading-weight)">
              {hob.name}
              {role !== null && <RoleTag role={role} />}
              <Said>{messages.said.title}</Said>
            </span>
            <span className="line-clamp-2 text-detail text-text-secondary" title={lane.title}>
              {lane.title}
              <Said>{messages.said.state}</Said>
            </span>
          </span>
          {/* Named by what it shows, then what it does, so speech input can say what it sees (WCAG 2.5.3). */}
          <StatusTag status={roomTone(lane.status)} said={messages.said.show({ name: hob.name })}>
            {roomStatusLabel(lane.status)}
          </StatusTag>
        </button>
        {slots.actions}
      </div>
      {slots.tries}
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 pt-1 pb-3">
        <ol aria-label={messages.did({ name: hob.name })} className="m-0 flex list-none flex-col gap-1.5 p-0">
          {shown.map((item) => (
            <LaneItemRow key={item.key} item={item} hobs={hobs} />
          ))}
        </ol>
        {folded && (
          <Button variant="ghost" size="xs" className="self-start" onClick={() => setOpened(true)}>
            {messages.showSteps({ count: all.length - results.length })}
          </Button>
        )}
        {reads !== undefined && <ReadState name={hob.name} reads={reads} />}
        {slots.cards}
      </div>
    </section>
  );
}

/** That more of what the hob did is on its way, or could not be read, with Try again. */
function ReadState({ name, reads }: { name: string; reads: LaneReads }) {
  if (!reads.failed) return <HubWait pending={reads.pending} onRetry={reads.retry} />;
  return (
    <p role="alert" className="m-0 flex flex-wrap items-center gap-x-2 text-detail text-rose">
      {messages.unread({ name })}
      <Button variant="ghost" size="xs" onClick={reads.retry}>
        {messages.tryAgain}
      </Button>
    </p>
  );
}

/** The hob's role beside its name in the lane's header. */
function RoleTag({ role }: { role: string }) {
  return (
    <span className="ms-1.5 font-sans text-meta font-normal text-label">
      <Said>{messages.said.role}</Said>
      {role}
    </span>
  );
}
