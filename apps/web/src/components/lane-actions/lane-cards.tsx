import type { AgentId, Task, TaskId, TaskTree } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { type ReactNode, useEffect, useRef } from "react";
import { controlError } from "../quest/control-room.ts";
import { messages as questCopy } from "../quest/messages.ts";
import { ConfirmCancel, Outcome, Refusal, taskLine } from "../quest/room-controls.tsx";
import type { HobLookup } from "../quest/use-work.ts";
import { taskTitle } from "../quest/work-model.ts";
import { type LaneFailure, laneFailures, laneQuestions } from "./lane-actions-model.ts";
import { LaneAsk } from "./lane-ask.tsx";
import { messages } from "./messages.ts";
import type { LaneActions } from "./use-lane-actions.ts";

const room = questCopy.room;

/**
 * What waits on you in a hob's lane (ADR 027), at the end of its body: a question for you lit in
 * lantern, a failed Task in rose with Retry and Reassign…, the question a cancel asks first, and
 * what each control came to as the hub recorded it, or why it refused.
 */
export function LaneCards({
  tree,
  lane,
  hobId,
  tasks,
  hobs,
  actions,
}: {
  tree: TaskTree;
  /** The Task the lane's header names, whose menu Reassign… opens. */
  lane: TaskId;
  hobId: AgentId;
  /** The hob's Tasks on the Quest, in order, without its steps. */
  tasks: ReadonlyArray<Task>;
  hobs: HobLookup;
  actions: LaneActions;
}) {
  const questions = laneQuestions(tree, tasks);
  const failures = laneFailures(tree, tasks);
  return (
    <div className="flex flex-col gap-2 empty:hidden">
      {questions.map(({ question }) => (
        <LaneAsk key={question.id} question={question} hobs={hobs} />
      ))}
      {failures.map((failure) => (
        <FailCard
          key={failure.task.id}
          lane={lane}
          failure={failure}
          titled={tasks.length > 1}
          hobs={hobs}
          actions={actions}
        />
      ))}
      {/* A step a cancel was asked about keeps its question and outcome in its owner's lane too. */}
      {tree.tasks
        .filter((task) => task.ownerId === hobId)
        .map((task) => (
          <TaskOutcome key={task.id} tree={tree} task={task} hobs={hobs} actions={actions} />
        ))}
    </div>
  );
}

/** A failed Task: what stopped it, and Retry and Reassign… where the hub would accept them. */
function FailCard({
  lane,
  failure,
  titled,
  hobs,
  actions,
}: {
  lane: TaskId;
  failure: LaneFailure;
  /** The lane holds more than one Task, so the card says which failed. */
  titled: boolean;
  hobs: HobLookup;
  actions: LaneActions;
}) {
  const { task } = failure;
  const name = hobs(task.ownerId).name;
  const retrying = actions.sending(task.id) === "retry";
  return (
    <section
      aria-label={messages.failed({ name })}
      className="flex flex-col gap-2 rounded-control border-(length:--edge) border-solid border-rose bg-[color-mix(in_srgb,var(--color-rose)_12%,var(--color-card))] p-2.5"
    >
      <span className="text-meta font-bold text-rose">
        {titled ? messages.failedTitle({ title: taskTitle(task) }) : messages.stopped}
      </span>
      <p className="m-0 text-ui whitespace-pre-wrap text-text-strong">{failure.reason ?? messages.stoppedWhy}</p>
      {(failure.retry || failure.reassign) && (
        <span className="flex flex-wrap gap-1.5">
          {failure.retry && (
            <Button
              size="sm"
              disabled={actions.busy}
              onClick={() => actions.send(task.id, { kind: "retry", taskId: task.id })}
            >
              {retrying ? messages.retrying : messages.retry}
            </Button>
          )}
          {failure.reassign && (
            <Button
              variant="outline"
              size="sm"
              disabled={actions.busy}
              onClick={() => actions.openMenu(lane, "reassign", task.id)}
            >
              {messages.reassign}
            </Button>
          )}
        </span>
      )}
    </section>
  );
}

/**
 * A Task's cancel question while it waits for Yes, then where the Task stands after a control:
 * queued for the new Attempt, or what a cancel came to, and why the hub refused one.
 */
function TaskOutcome({
  tree,
  task,
  hobs,
  actions,
}: {
  tree: TaskTree;
  task: Task;
  hobs: HobLookup;
  actions: LaneActions;
}) {
  const owner = hobs(task.ownerId).name;
  const top = task.id === tree.tasks[0]?.id;
  const quest = top ? tree.quests.find((each) => each.taskId === task.id) : undefined;
  const refusal = actions.refusal(task.id);
  return (
    <>
      {actions.asking(task.id) && (
        <TakesFocus>
          <ConfirmCancel
            question={
              top
                ? quest !== undefined
                  ? room.confirmQuest
                  : room.confirmRequest
                : room.confirmTask({ title: taskTitle(task) })
            }
            pending={actions.sending(task.id) !== null}
            onYes={() =>
              actions.send(
                task.id,
                quest !== undefined ? { kind: "cancelQuest", questId: quest.id } : { kind: "cancel", taskId: task.id },
              )
            }
            onKeep={() => actions.ask(null)}
          />
        </TakesFocus>
      )}
      <Outcome>{taskLine(tree, task, owner)}</Outcome>
      <Refusal>
        {refusal === null ? null : controlError(refusal.error, { owner, target: refusal.target?.name ?? owner })}
      </Refusal>
    </>
  );
}

/**
 * Moves keyboard focus to the last button inside once it shows, as a question asked from a menu
 * does: Keep it, so a stray Enter never cancels.
 */
function TakesFocus({ children }: { children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // After the frame the menu that asked closes in, so its focus trap has let go.
    const frame = requestAnimationFrame(() =>
      [...(box.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])].at(-1)?.focus(),
    );
    return () => cancelAnimationFrame(frame);
  }, []);
  return <div ref={box}>{children}</div>;
}
