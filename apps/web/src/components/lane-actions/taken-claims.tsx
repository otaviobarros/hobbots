import { Claims, type Task } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { DropdownMenuItem, DropdownMenuLabel } from "@hobbots/ui/components/menu";
import { useTaskClaims } from "../../api/task-claims.ts";
import { Outcome, Refusal } from "../quest/room-controls.tsx";
import { canTakeOver } from "./lane-actions-model.ts";
import { messages } from "./messages.ts";
import type { LaneActions } from "./use-lane-actions.ts";

/**
 * What you took over of a Task (#1449), as the claims register holds it, while Take over is on its
 * way, and why it did not go through. A read that failed says so, with Try again, rather than
 * showing the Task as holding nothing.
 */
export function TakenClaims({ task, actions }: { task: Task; actions: LaneActions }) {
  const read = useTaskClaims(task);
  const taken = (read.claims ?? []).filter(Claims.isTaken);
  const refusal = actions.takeOverRefusal(task.id);
  return (
    <>
      <Outcome>
        {actions.takingOver(task.id)
          ? messages.takingOver
          : taken.length > 0
            ? messages.taken({ claims: taken })
            : null}
      </Outcome>
      <Refusal>{refusal === null ? null : messages.takeOverFailed}</Refusal>
      {read.failed && (
        <p className="m-0 flex flex-wrap items-center gap-2 text-meta text-text-secondary">
          <span role="alert">{messages.claimsUnread}</span>
          <Button type="button" variant="chip" size="xs" onClick={read.retry}>
            {messages.claimsRetry}
          </Button>
        </p>
      )}
    </>
  );
}

/**
 * Take over in a lane's ⋯ menu (#1449), once the hub says the Task holds files or branches you have
 * not taken over, with what it leaves the hob. The menu stays open until the hub moved them to you.
 */
export function TakeOverItems({ task, owner, actions }: { task: Task; owner: string; actions: LaneActions }) {
  const { claims } = useTaskClaims(task);
  if (!canTakeOver(task, claims)) return null;
  return (
    <>
      <DropdownMenuItem
        disabled={actions.busy}
        onSelect={(event) => {
          event.preventDefault();
          actions.takeOver(task.id);
        }}
      >
        {messages.takeOver}
      </DropdownMenuItem>
      <DropdownMenuLabel>{messages.takeOverKeeps({ name: owner })}</DropdownMenuLabel>
    </>
  );
}
