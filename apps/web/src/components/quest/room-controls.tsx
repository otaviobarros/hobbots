import type { Quest, Task, TaskTree } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { useTaskControl } from "../../api/task-controls.ts";
import { cancelOutcome, controlError, pendingStart, type TopCancel } from "./control-room.ts";
import { messages } from "./messages.ts";
import type { HobLookup } from "./use-work.ts";

const copy = messages.room;

/** A line that says where a control stands; read out as it changes. */
export function Outcome({ children }: { children: string | null }) {
  return (
    <p role="status" className="m-0 text-meta text-text-secondary empty:hidden">
      {children}
    </p>
  );
}

/** Why a control was refused or could not be sent. */
export function Refusal({ children }: { children: string | null }) {
  return children === null ? null : (
    <p role="alert" className="m-0 text-meta text-rose">
      {children}
    </p>
  );
}

/** What a cancel did under a Task: still confirming, every Task confirmed, or some left unresolved. */
const cancelLine = (tree: TaskTree, task: Task): string | null => {
  const outcome = cancelOutcome(tree, task);
  if (outcome === null) return null;
  if (!outcome.settled) return copy.confirming(outcome);
  return outcome.unresolved > 0 ? copy.unresolved({ count: outcome.unresolved }) : copy.confirmedAll(outcome);
};

/**
 * Where the open Task stands after a control: queued for the new Attempt a retry or reassignment
 * asked for, or what a cancel came to. The top Task's cancel shows under Cancel Quest instead.
 */
export const taskLine = (tree: TaskTree, task: Task, owner: string): string | null => {
  const queued = pendingStart(tree, task);
  if (queued !== null) return copy.queued({ name: owner, count: queued.attempt });
  return task.parentId === null ? null : cancelLine(tree, task);
};

/** Asks before a cancel, which cannot be undone: the question, then Yes or Keep it. */
export function ConfirmCancel({
  question,
  pending,
  onYes,
  onKeep,
}: {
  question: string;
  pending: boolean;
  onYes: () => void;
  onKeep: () => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <p className="m-0 text-meta text-text-strong">{question}</p>
      <span className="flex flex-wrap gap-1.5">
        <Button variant="deny" size="xs" disabled={pending} onClick={onYes}>
          {pending ? copy.cancelling : copy.yesCancel}
        </Button>
        <Button variant="outline" size="xs" disabled={pending} onClick={onKeep}>
          {copy.keep}
        </Button>
      </span>
    </div>
  );
}

/**
 * Cancel Quest for the whole request (Cancel Task while no party joined): asked first, then
 * Cancelling… until every Task confirms, then what the cancel came to. The quest's ⋯ menu
 * asks it, so the room holds whether the question is open.
 */
export function TopControls({
  tree,
  top,
  hobs,
  cancel,
  quest,
  asked,
}: {
  tree: TaskTree;
  top: Task;
  hobs: HobLookup;
  cancel: TopCancel;
  quest: Quest | null;
  /** Whether the question is open, and how to close it: the room's ⋯ menu asks it. */
  asked: { readonly open: boolean; readonly set: (open: boolean) => void };
}) {
  const { open: asking, set: setAsking } = asked;
  const control = useTaskControl();
  const outcome = cancelLine(tree, top);
  if (cancel === "ended" && outcome === null) return null;
  const owner = hobs(top.ownerId).name;
  return (
    <div className="flex flex-col gap-1.5 empty:hidden">
      {cancel === "cancelling" && (
        <span className="flex">
          <Button variant="deny" size="xs" disabled>
            {copy.cancelling}
          </Button>
        </span>
      )}
      {cancel === "open" && asking && (
        <ConfirmCancel
          question={quest !== null ? copy.confirmQuest : copy.confirmRequest}
          pending={control.isPending}
          onYes={() =>
            control.mutate(
              quest !== null ? { kind: "cancelQuest", questId: quest.id } : { kind: "cancel", taskId: top.id },
              { onSuccess: () => setAsking(false) },
            )
          }
          onKeep={() => setAsking(false)}
        />
      )}
      <Outcome>{outcome}</Outcome>
      <Refusal>{control.isError ? controlError(control.error, { owner, target: owner }) : null}</Refusal>
    </div>
  );
}
