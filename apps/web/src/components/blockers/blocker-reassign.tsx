import type { Agent, BackpackItem, TaskTree, ThreadId } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@hobbots/ui/components/menu";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { agentsQuery } from "../../api/queries.ts";
import { useTaskControl } from "../../api/task-controls.ts";
import { threadTasksQuery } from "../../api/tasks.ts";
import { HobSprite } from "../hob-sprite/hob-sprite.tsx";
import { controlError, reassignTargets } from "../quest/control-room.ts";
import { taskTitle } from "../quest/work-model.ts";
import { reassignable } from "./blocker-model.ts";
import { messages } from "./messages.ts";

const copy = messages;

const NO_HOBS: ReadonlyArray<Agent> = [];
const NO_TREES: ReadonlyArray<TaskTree> = [];

/**
 * Reassign… on a stuck card: the hobs the hub would give the item's Task to, each with its sprite.
 * Picking one sends the Task to it as the lane's menu does; the hub then closes the stuck item, so
 * the card leaves. `onSent` hears the send, for a card that moves focus and says what was sent.
 * Nothing shows while the Task cannot change hands.
 */
export function BlockerReassign({
  item,
  threadId,
  owner,
  disabled,
  onSent,
}: {
  item: BackpackItem;
  /** The thread the item's Task tree belongs to. */
  threadId: ThreadId;
  /** The stuck hob's name, which a refusal names. */
  owner: string;
  disabled: boolean;
  onSent: (sent: Promise<unknown>, to: Agent) => void;
}) {
  const read = useQuery(threadTasksQuery(threadId));
  const hobs = useQuery(agentsQuery).data ?? NO_HOBS;
  const control = useTaskControl();
  const [target, setTarget] = useState<Agent | null>(null);
  const found = reassignable(read.data?.trees ?? NO_TREES, item);
  if (found === null) return null;
  const { tree, task } = found;
  const targets = reassignTargets(
    tree,
    task,
    hobs.filter((hob) => hob.status !== "retired"),
  );
  const give = (to: Agent) => {
    setTarget(to);
    onSent(control.mutateAsync({ kind: "reassign", taskId: task.id, agentId: to.id }), to);
  };
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="xs" variant="outline" disabled={disabled || control.isPending}>
            {copy.reassign}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuLabel>{copy.reassignTo({ title: taskTitle(task) })}</DropdownMenuLabel>
          {targets.length === 0 && <DropdownMenuLabel>{copy.noOneElse}</DropdownMenuLabel>}
          {targets.map((hob) => (
            <DropdownMenuItem key={hob.id} inset onSelect={() => give(hob)}>
              <HobSprite hob={hob} size={16} />
              {hob.name}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {control.isError && (
        <p role="alert" className="m-0 basis-full text-meta text-rose">
          {controlError(control.error, { owner, target: target?.name ?? owner })}
        </p>
      )}
    </>
  );
}
