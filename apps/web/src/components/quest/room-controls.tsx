import type { Task, TaskTree } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
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
  const controls = task === null ? null : taskControls(tree, task);
  const attempts = task === null ? 0 : attemptCount(tree, task);
  const shown = controls !== null && (controls.retry || controls.reassign || controls.cancel);
  return (
    <div className="flex flex-col gap-2 border-t-2 border-line px-3.5 py-2.5">
      {task === null ? (
        <p className="m-0 text-xs text-label">{copy.pick}</p>
      ) : (
        <section aria-label={copy.controls({ title: taskTitle(task) })} className="flex flex-col gap-1.5">
          <span className="truncate text-detail">
            <b>{hobs(task.ownerId).name}</b> · {taskTitle(task)}
          </span>
          <span className="text-xs text-label">
            {attempts === 0 ? copy.notStarted : copy.attempt({ count: attempts })}
          </span>
          {shown && (
            <span className="flex flex-wrap gap-1.5">
              {controls.retry && <Held variant="outline">{copy.retry}</Held>}
              {controls.reassign && <Held variant="outline">{copy.reassign}</Held>}
              {controls.cancel && <Held variant="deny">{copy.cancelTask}</Held>}
            </span>
          )}
        </section>
      )}
      {cancel !== "ended" && (
        <span className="flex">
          <Held variant="deny">
            {cancel === "cancelling" ? copy.cancelling : hasQuest ? copy.cancelQuest : copy.cancelTask}
          </Held>
        </span>
      )}
      {(shown || cancel === "open") && <p className="m-0 text-xs text-label">{copy.held}</p>}
    </div>
  );
}

/** A control the hub cannot carry out with a confirmed outcome yet. */
function Held({ variant, children }: { variant: "outline" | "deny"; children: string }) {
  return (
    <Button variant={variant} size="xs" disabled>
      {children}
    </Button>
  );
}
