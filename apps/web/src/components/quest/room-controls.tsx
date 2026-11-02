import type { Agent, Quest, Task, TaskTree } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { agentsQuery } from "../../api/queries.ts";
import { type TaskControl, useTaskControl } from "../../api/task-controls.ts";
import { HobSprite } from "../hob-sprite.tsx";
import {
  attemptCount,
  cancelOutcome,
  controlError,
  pendingStart,
  reassignTargets,
  type TopCancel,
  taskControls,
} from "./control-room.ts";
import { messages } from "./messages.ts";
import type { HobLookup } from "./use-work.ts";
import { taskTitle } from "./work-model.ts";

const copy = messages.room;

const NO_HOBS: ReadonlyArray<Agent> = [];

/**
 * The controls of the Quest tab (ADR 018): Retry, Reassign and Cancel Task for the Task open in the
 * drawer, and Cancel Quest for the whole request. Each acts on the Task directly, never through the
 * lead. What the tab shows after is what the hub recorded (OR-006): a cancel asked for reads as
 * cancelling until each Task under it confirms it stopped or is left unresolved, and a retry or
 * reassignment reads as queued until its owner starts the new Attempt.
 */
export function RoomControls({
  tree,
  task,
  hobs,
  cancel,
  quest,
  onWorkbench,
}: {
  tree: TaskTree;
  /** The Task open in the drawer, when it is in this tree. */
  task: Task | null;
  hobs: HobLookup;
  cancel: TopCancel;
  quest: Quest | null;
  /** Opens a Task's Workbench (ADR 023). */
  onWorkbench: (taskId: Task["id"]) => void;
}) {
  const top = tree.tasks[0];
  return (
    <div className="flex flex-col gap-2 border-t-2 border-line px-3.5 py-2.5">
      {task === null ? (
        <p className="m-0 text-xs text-label">{copy.pick}</p>
      ) : (
        // A new Task starts with nothing asked and nothing open.
        <TaskControlsFor key={task.id} tree={tree} task={task} hobs={hobs} onWorkbench={onWorkbench} />
      )}
      {top !== undefined && (
        <TopControls key={top.id} tree={tree} top={top} hobs={hobs} cancel={cancel} quest={quest} />
      )}
    </div>
  );
}

/** A line that says where a control stands; read out as it changes. */
function Outcome({ children }: { children: string | null }) {
  return (
    <p role="status" className="m-0 text-xs text-secondary-text empty:hidden">
      {children}
    </p>
  );
}

/** Why a control was refused or could not be sent. */
function Refusal({ children }: { children: string | null }) {
  return children === null ? null : (
    <p role="alert" className="m-0 text-xs text-rose">
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
const taskLine = (tree: TaskTree, task: Task, owner: string): string | null => {
  const queued = pendingStart(tree, task);
  if (queued !== null) return copy.queued({ name: owner, count: queued.attempt });
  return task.parentId === null ? null : cancelLine(tree, task);
};

/** Asks before a cancel, which cannot be undone: the question, then Yes or Keep it. */
function ConfirmCancel({
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
      <p className="m-0 text-xs text-text">{question}</p>
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

/** The open Task's owner, title and attempt, with the controls that apply to it. */
function TaskControlsFor({
  tree,
  task,
  hobs,
  onWorkbench,
}: {
  tree: TaskTree;
  task: Task;
  hobs: HobLookup;
  onWorkbench: (taskId: Task["id"]) => void;
}) {
  const [open, setOpen] = useState<"reassign" | "cancel" | null>(null);
  const [target, setTarget] = useState<Agent | null>(null);
  const control = useTaskControl();
  const controls = taskControls(tree, task);
  const attempts = attemptCount(tree, task);
  const owner = hobs(task.ownerId).name;
  const title = taskTitle(task);
  const sending = (kind: TaskControl["kind"]) => control.isPending && control.variables?.kind === kind;
  const run = (next: TaskControl) => control.mutate(next, { onSuccess: () => setOpen(null) });
  const toggle = (which: "reassign" | "cancel") => {
    control.reset();
    setOpen(open === which ? null : which);
  };
  return (
    <section aria-label={copy.controls({ title })} className="flex flex-col gap-1.5">
      <span className="truncate text-detail">{copy.row({ name: owner, title })}</span>
      <span className="text-xs text-label">{attempts === 0 ? copy.notStarted : copy.attempt({ count: attempts })}</span>
      <span className="flex flex-wrap gap-1.5 empty:hidden">
        <Button variant="outline" size="xs" onClick={() => onWorkbench(task.id)}>
          {copy.workbench}
        </Button>
        {controls.retry && (
          <Button
            variant="outline"
            size="xs"
            disabled={control.isPending}
            onClick={() => {
              setOpen(null);
              run({ kind: "retry", taskId: task.id });
            }}
          >
            {sending("retry") ? copy.retrying : copy.retry}
          </Button>
        )}
        {controls.reassign && (
          <Button
            variant="outline"
            size="xs"
            aria-expanded={open === "reassign"}
            disabled={control.isPending}
            onClick={() => toggle("reassign")}
          >
            {copy.reassign}
          </Button>
        )}
        {controls.cancel && (
          <Button
            variant="deny"
            size="xs"
            aria-expanded={open === "cancel"}
            disabled={control.isPending}
            onClick={() => toggle("cancel")}
          >
            {copy.cancelTask}
          </Button>
        )}
      </span>
      {open === "reassign" && controls.reassign && (
        <ReassignPicker
          tree={tree}
          task={task}
          sending={sending("reassign") ? target : null}
          onPick={(hob) => {
            setTarget(hob);
            run({ kind: "reassign", taskId: task.id, agentId: hob.id });
          }}
          onKeep={() => setOpen(null)}
        />
      )}
      {open === "cancel" && controls.cancel && (
        <ConfirmCancel
          question={copy.confirmTask({ title })}
          pending={sending("cancel")}
          onYes={() => run({ kind: "cancel", taskId: task.id })}
          onKeep={() => setOpen(null)}
        />
      )}
      <Outcome>{taskLine(tree, task, owner)}</Outcome>
      <Refusal>
        {control.isError ? controlError(control.error, { owner, target: target?.name ?? owner }) : null}
      </Refusal>
    </section>
  );
}

/** The hobs that can take the Task, each a button that gives it to them. */
function ReassignPicker({
  tree,
  task,
  sending,
  onPick,
  onKeep,
}: {
  tree: TaskTree;
  task: Task;
  /** The hob it is being given to, while that is on its way. */
  sending: Agent | null;
  onPick: (hob: Agent) => void;
  onKeep: () => void;
}) {
  const active = (useQuery(agentsQuery).data ?? NO_HOBS).filter((hob) => hob.status !== "retired");
  const targets = reassignTargets(tree, task, active);
  const label = copy.giveTo({ title: taskTitle(task) });
  return (
    <fieldset aria-label={label} className="m-0 flex min-w-0 flex-col gap-1.5 border-0 p-0">
      <legend className="p-0 text-xs text-label">
        {sending === null ? label : copy.giving({ name: sending.name })}
      </legend>
      {targets.length === 0 ? (
        <p className="m-0 text-xs text-label">{copy.noOneElse}</p>
      ) : (
        <span className="flex flex-wrap gap-1.5">
          {targets.map((hob) => (
            <Button key={hob.id} variant="chip" size="xs" disabled={sending !== null} onClick={() => onPick(hob)}>
              <HobSprite hob={hob} size={16} />
              {hob.name}
            </Button>
          ))}
        </span>
      )}
      <span className="flex">
        <Button variant="outline" size="xs" disabled={sending !== null} onClick={onKeep}>
          {copy.keep}
        </Button>
      </span>
    </fieldset>
  );
}

/**
 * Cancel Quest for the whole request (Cancel Task while no party joined): asked first, then
 * Cancelling… until every Task confirms, then what the cancel came to.
 */
function TopControls({
  tree,
  top,
  hobs,
  cancel,
  quest,
}: {
  tree: TaskTree;
  top: Task;
  hobs: HobLookup;
  cancel: TopCancel;
  quest: Quest | null;
}) {
  const [asking, setAsking] = useState(false);
  const control = useTaskControl();
  const label = quest !== null ? copy.cancelQuest : copy.cancelTask;
  const outcome = cancelLine(tree, top);
  if (cancel === "ended" && outcome === null) return null;
  const owner = hobs(top.ownerId).name;
  return (
    <div className="flex flex-col gap-1.5">
      {cancel === "open" && (
        <span className="flex">
          <Button
            variant="deny"
            size="xs"
            aria-expanded={asking}
            disabled={control.isPending}
            onClick={() => {
              control.reset();
              setAsking(!asking);
            }}
          >
            {label}
          </Button>
        </span>
      )}
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
