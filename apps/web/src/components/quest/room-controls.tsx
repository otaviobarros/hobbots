import type { Task, TaskTree } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { useId } from "react";
import { attemptCount, type TopCancel, taskControls } from "./control-room.ts";
import { messages } from "./messages.ts";
import type { HobLookup } from "./use-work.ts";
import { taskTitle } from "./work-model.ts";

const copy = messages.room;

/**
 * The controls of the Quest tab (ADR 018): Retry, Reassign and Cancel Task for the Task open in the
 * drawer, and Cancel Quest for the whole request. Each acts on the Task directly, never through the
 * lead, and only once the hub can confirm what it did (OR-006); until then they show, held, so you
 * can see what will apply.
 */
export function RoomControls({
  tree,
  task,
  hobs,
  cancel,
  hasQuest,
}: {
  tree: TaskTree;
  /** The Task open in the drawer, when it is in this tree. */
  task: Task | null;
  hobs: HobLookup;
  cancel: TopCancel;
  hasQuest: boolean;
}) {
  const held = useId();
  const shown = task !== null && Object.values(taskControls(tree, task)).some(Boolean);
  return (
    <div className="flex flex-col gap-2 border-t-2 border-line px-3.5 py-2.5">
      {task === null ? (
        <p className="m-0 text-xs text-label">{copy.pick}</p>
      ) : (
        <TaskControlsFor tree={tree} task={task} hobs={hobs} held={held} />
      )}
      {cancel !== "ended" && (
        <span className="flex">
          <Held variant="deny" describedBy={held}>
            {cancel === "cancelling" ? copy.cancelling : hasQuest ? copy.cancelQuest : copy.cancelTask}
          </Held>
        </span>
      )}
      {(shown || cancel === "open") && (
        <p id={held} className="m-0 text-xs text-label">
          {copy.held}
        </p>
      )}
    </div>
  );
}

/** The open Task's owner, title and attempt, with the controls that apply to it. */
function TaskControlsFor({ tree, task, hobs, held }: { tree: TaskTree; task: Task; hobs: HobLookup; held: string }) {
  const controls = taskControls(tree, task);
  const attempts = attemptCount(tree, task);
  return (
    <section aria-label={copy.controls({ title: taskTitle(task) })} className="flex flex-col gap-1.5">
      <span className="truncate text-detail">
        {copy.row({ name: hobs(task.ownerId).name, title: taskTitle(task) })}
      </span>
      <span className="text-xs text-label">{attempts === 0 ? copy.notStarted : copy.attempt({ count: attempts })}</span>
      <span className="flex flex-wrap gap-1.5 empty:hidden">
        {controls.retry && (
          <Held variant="outline" describedBy={held}>
            {copy.retry}
          </Held>
        )}
        {controls.reassign && (
          <Held variant="outline" describedBy={held}>
            {copy.reassign}
          </Held>
        )}
        {controls.cancel && (
          <Held variant="deny" describedBy={held}>
            {copy.cancelTask}
          </Held>
        )}
      </span>
    </section>
  );
}

/**
 * A control the hub cannot carry out with a confirmed outcome yet. It stays in the tab order,
 * marked unavailable and described by why, so a keyboard user still finds it.
 */
function Held({
  variant,
  describedBy,
  children,
}: {
  variant: "outline" | "deny";
  describedBy: string;
  children: string;
}) {
  return (
    <Button
      variant={variant}
      size="xs"
      aria-disabled
      aria-describedby={describedBy}
      className="cursor-default opacity-50"
    >
      {children}
    </Button>
  );
}
