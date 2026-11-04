import type { BackpackItem, TaskId, TaskTree } from "@hobbots/domain";
import { useBlockers } from "../../api/blockers.ts";
import { blockersOn } from "../blockers/blocker-model.ts";
import { type HobState, HobTile } from "../hob-sprite/hob-sprite.tsx";
import { roomTone } from "../quest/control-room.ts";
import { StatusTag } from "../quest/status-dot.tsx";
import type { HobLookup } from "../quest/use-work.ts";
import type { RowStatus } from "../quest/work-model.ts";
import { messages } from "./messages.ts";
import { questTicket } from "./ticket-model.ts";

/** How each sprite on a running ticket moves for where its lane stands: working bobs, waiting dozes. */
const MOOD: Readonly<Record<RowStatus, HobState>> = {
  running: "working",
  waiting: "asleep",
  blocked: "waiting",
  "needs-you": "needs-you",
  failed: "failed",
  done: "idle",
};

/** The work about this tree's Tasks that failed as a blocker and waits for you (IN-007). */
const useStuck = (tree: TaskTree): ReadonlyArray<BackpackItem> =>
  blockersOn(useBlockers(), new Set(tree.tasks.map((task) => task.id)));

/**
 * The ticket under the request that started a Task (ADR 027): one line that never grows, with the
 * party's sprites, the title, how far the work is or how it ended, a tag when something waits on
 * you, and Open room. It is one button, named for the Quest and where it stands, and opens the
 * Quest room beside the chat. It updates live as the Task tree does.
 */
export function QuestTicket({
  tree,
  hobs,
  onOpen,
}: {
  tree: TaskTree;
  hobs: HobLookup;
  /** Opens the Quest room on a Task. */
  onOpen: (taskId: TaskId) => void;
}) {
  const ticket = questTicket(tree);
  const stuck = useStuck(tree).length > 0;
  if (ticket === null) return null;
  const ended = ticket.progress.kind === "ended";
  const progress = messages.progress(ticket.progress);
  const needs = ticket.needsYou > 0 ? messages.needsYou(ticket.needsYou) : null;
  const state = [progress, needs, stuck ? messages.stuck : null].filter((part) => part !== null).join(", ");
  return (
    <button
      type="button"
      aria-label={messages.label({ title: ticket.title, state })}
      onClick={() => onOpen(ticket.top.id)}
      className="ms-10 flex w-[calc(100%-2.5rem)] max-w-work-max animate-hb-in cursor-pointer items-center gap-3 rounded-card border-(length:--edge) border-line-2 bg-card px-3 py-2 text-start text-text-strong transition-colors hover:bg-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
    >
      <span aria-hidden className="flex shrink-0">
        {ticket.party.map((member) => (
          <span key={member.hobId} className="-ms-1.5 rounded-tile shadow-[0_0_0_2px_var(--color-card)] first:ms-0">
            <HobTile hob={hobs(member.hobId)} tile="sm" state={ended ? "idle" : MOOD[roomTone(member.status)]} />
          </span>
        ))}
      </span>
      <span className="min-w-0 truncate font-heading text-body font-(--heading-weight)">{ticket.title}</span>
      <span className="min-w-0 shrink truncate text-detail text-text-secondary">{progress}</span>
      {needs !== null && <StatusTag status="needs-you">{needs}</StatusTag>}
      {stuck && <StatusTag status="blocked">{messages.stuck}</StatusTag>}
      <span className="ms-auto shrink-0 text-ui font-bold whitespace-nowrap text-lantern">
        {messages.openRoom} <span aria-hidden>→</span>
      </span>
    </button>
  );
}
