import type { BackpackItem, TaskId, TaskTree } from "@hobbots/domain";
import { cn } from "@hobbots/ui/lib/utils";
import { useBlockers } from "../../api/blockers.ts";
import { blockersOn } from "../blockers/blocker-model.ts";
import { type HobState, HobTile } from "../hob-sprite/hob-sprite.tsx";
import { roomTone } from "../quest/control-room.ts";
import { StatusTag } from "../quest/status-dot.tsx";
import { useQuestProgress } from "../quest/use-quest-progress.ts";
import type { HobLookup } from "../quest/use-work.ts";
import type { RowStatus } from "../quest/work-model.ts";
import { Said } from "../said/said.tsx";
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

/** The most sprites the ticket shows, in a chat of its full width and in a narrow chat column. */
const WIDE_SPRITES = 4;
const NARROW_SPRITES = 2;

/** The work about this tree's Tasks that failed as a blocker and waits for you (IN-007). */
const useStuck = (tree: TaskTree): ReadonlyArray<BackpackItem> =>
  blockersOn(useBlockers(), new Set(tree.tasks.map((task) => task.id)));

/**
 * The ticket under the request that started a Task (ADR 027): one line that never grows with the
 * work, with the party's sprites, the title, how far the work is or how it ended, a tag when
 * something waits on you, and Open quest. In a narrow chat column it keeps a fixed second line for
 * the state. It is one button, named for the Quest and where it stands, and opens the quest in the
 * chat's sheet (ADR 037). It updates live as the Task tree does.
 */
export function QuestTicket({
  tree,
  hobs,
  onOpen,
}: {
  tree: TaskTree;
  hobs: HobLookup;
  /** Opens the quest in the chat's sheet, on a Task. */
  onOpen: (taskId: TaskId) => void;
}) {
  const ticket = questTicket(tree, useQuestProgress(tree));
  const stuck = useStuck(tree).length > 0;
  if (ticket === null) return null;
  const ended = ticket.progress.kind === "ended";
  const progress = messages.progress(ticket.progress);
  const needs = ticket.needsYou > 0 ? messages.needsYou(ticket.needsYou) : null;
  const sprites = ticket.party.slice(0, WIDE_SPRITES);
  // A screen reader hears a comma between the parts of the state, and a stop after the last one.
  const after = (more: boolean) => (more ? messages.said.part : messages.said.open);
  return (
    <button
      type="button"
      onClick={() => onOpen(ticket.top.id)}
      className="@container/ticket ms-10 block w-[calc(100%-2.5rem)] max-w-work-max animate-hb-in cursor-pointer rounded-card border-(length:--edge) border-line-2 bg-card px-3 py-2 text-start text-text-strong transition-colors hover:bg-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
    >
      {/* A narrow chat column, as beside the room at 1024 px, gives the title and the arrow the first
          line and puts fewer sprites and the state on a second, so each stays readable. */}
      <span className="flex items-center gap-x-3 gap-y-1 @max-sm/ticket:flex-wrap">
        <span aria-hidden className="flex shrink-0 items-center @max-sm/ticket:order-3">
          {sprites.map((member, index) => (
            <span
              key={member.hobId}
              className={cn(
                "-ms-1.5 rounded-tile shadow-[0_0_0_2px_var(--color-card)] first:ms-0",
                index >= NARROW_SPRITES && "@max-sm/ticket:hidden",
              )}
            >
              <HobTile hob={hobs(member.hobId)} tile="sm" state={ended ? "idle" : MOOD[roomTone(member.status)]} />
            </span>
          ))}
          <More count={ticket.party.length - WIDE_SPRITES} narrow={false} />
          <More count={ticket.party.length - NARROW_SPRITES} narrow />
        </span>
        <span className="min-w-0 flex-1 truncate font-heading text-body font-(--heading-weight) @max-sm/ticket:order-1 @max-sm/ticket:basis-[calc(100%-2rem)] @sm/ticket:flex-initial">
          {ticket.title}
          <Said>{messages.said.title}</Said>
        </span>
        <span className="flex min-w-0 items-center gap-2 @max-sm/ticket:order-4 @max-sm/ticket:flex-1">
          <span className="min-w-0 truncate text-detail text-text-secondary">
            {progress}
            <Said>{after(needs !== null || stuck)}</Said>
          </span>
          {needs !== null && (
            <StatusTag status="needs-you" said={after(stuck)}>
              {needs}
            </StatusTag>
          )}
          {stuck && (
            <StatusTag status="blocked" said={messages.said.open}>
              {messages.stuck}
            </StatusTag>
          )}
        </span>
        <span className="ms-auto shrink-0 text-ui font-bold whitespace-nowrap text-lantern @max-sm/ticket:order-2">
          <span className="@max-sm/ticket:sr-only">{messages.openQuest} </span>
          <span aria-hidden>→</span>
        </span>
      </span>
    </button>
  );
}

/**
 * How many more hobs are on the Quest than the ticket has room to show: the `narrow` count shows only
 * in a narrow chat column, the other only in a wide one.
 */
function More({ count, narrow }: { count: number; narrow: boolean }) {
  if (count <= 0) return null;
  return (
    <span
      className={cn(
        "ms-1 text-meta font-bold whitespace-nowrap text-text-secondary",
        narrow ? "hidden @max-sm/ticket:inline" : "@max-sm/ticket:hidden",
      )}
    >
      {messages.more(count)}
    </span>
  );
}
