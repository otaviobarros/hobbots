import type { Agent, BackpackItem, Task, TaskTree, ThreadId } from "@hobbots/domain";
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
import { HobMenuItems } from "../hob-sprite/hob-menu-items.tsx";
import { HubWait } from "../loading/hub-wait.tsx";
import { controlError, reassignTargets } from "../quest/control-room.ts";
import { taskTitle } from "../quest/work-model.ts";
import { reassignable } from "./blocker-model.ts";
import { messages } from "./messages.ts";

const copy = messages;

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
  const control = useTaskControl();
  const [target, setTarget] = useState<Agent | null>(null);
  // Whether the Task can change hands is unknown until its tree is read: the card says so, never
  // that it cannot (STD-REACT-015).
  if (read.isError) return <ReadFailed text={copy.reassignUnread} onRetry={() => void read.refetch()} />;
  if (read.isPending) {
    return (
      <>
        <Button size="xs" variant="outline" disabled aria-busy>
          {copy.reassign}
        </Button>
        <HubWait pending onRetry={() => void read.refetch()} />
      </>
    );
  }
  const found = reassignable(read.data.trees, item);
  if (found === null) return null;
  const { tree, task } = found;
  const give = (to: Agent) => {
    setTarget(to);
    onSent(control.mutateAsync({ kind: "reassign", taskId: task.id, agentId: to.id }), to);
  };
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="xs" variant="outline" disabled={disabled || control.isPending}>
            {control.isPending ? copy.reassigning : copy.reassign}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuLabel>{copy.reassignTo({ title: taskTitle(task) })}</DropdownMenuLabel>
          <ReassignTargets tree={tree} task={task} onPick={give} />
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

/** The hobs the Task can go to, once your hobs are read: a wait while they are, Try again if they could not be. */
function ReassignTargets({ tree, task, onPick }: { tree: TaskTree; task: Task; onPick: (to: Agent) => void }) {
  const read = useQuery(agentsQuery);
  if (read.isPending) return <DropdownMenuLabel aria-busy>{copy.readingHobs}</DropdownMenuLabel>;
  if (read.isError) {
    return (
      <>
        <DropdownMenuLabel>{copy.hobsUnread}</DropdownMenuLabel>
        <DropdownMenuItem
          onSelect={(event) => {
            // Stays open on the hobs once they are read.
            event.preventDefault();
            void read.refetch();
          }}
        >
          {copy.tryAgain}
        </DropdownMenuItem>
      </>
    );
  }
  const targets = reassignTargets(
    tree,
    task,
    read.data.filter((hob) => hob.status !== "retired"),
  );
  if (targets.length === 0) return <DropdownMenuLabel>{copy.noOneElse}</DropdownMenuLabel>;
  return <HobMenuItems hobs={targets} onPick={onPick} />;
}

/** A read the card needs failed: what could not be read, and Try again. */
function ReadFailed({ text, onRetry }: { text: string; onRetry: () => void }) {
  return (
    <p role="alert" className="m-0 flex basis-full flex-wrap items-center gap-x-2 text-meta text-rose">
      {text}
      <Button variant="ghost" size="xs" onClick={onRetry}>
        {copy.tryAgain}
      </Button>
    </p>
  );
}
