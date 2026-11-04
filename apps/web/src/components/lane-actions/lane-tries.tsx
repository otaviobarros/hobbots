import type { AttemptId, Task, TaskTree } from "@hobbots/domain";
import { laneTries } from "./lane-actions-model.ts";
import { messages } from "./messages.ts";

/**
 * The attempt picker under a lane's header once its Task has more than one try (ADR 027):
 * "Try 1 ✗ · 2". Picking a try shows what it did in the lane and in the Workbench.
 */
export function LaneTries({
  tree,
  task,
  name,
  picked,
  onPick,
}: {
  tree: TaskTree;
  task: Task;
  /** The lane's hob, which names the group. */
  name: string;
  /** The try the address names, if any. */
  picked: AttemptId | undefined;
  onPick: (attemptId: AttemptId) => void;
}) {
  const tries = laneTries(tree, task, picked);
  if (tries.length === 0) return null;
  return (
    <fieldset
      aria-label={messages.tries({ name })}
      className="m-0 flex flex-wrap items-center gap-1 border-0 px-3 pb-1.5 text-meta text-label"
    >
      <span aria-hidden>{messages.try}</span>
      {tries.map(({ attempt, failed, picked: shown }) => (
        <button
          key={attempt.id}
          type="button"
          aria-pressed={shown}
          aria-label={messages.tryLabel({ number: attempt.number, failed })}
          onClick={() => onPick(attempt.id)}
          className="h-5.5 min-w-6 cursor-pointer rounded-tag border-(length:--edge) border-solid border-line-2 bg-transparent px-1.5 text-meta text-text-secondary hover:bg-hover focus-visible:outline-2 focus-visible:outline-focus-ring aria-pressed:border-focus-ring aria-pressed:bg-card aria-pressed:text-text-strong"
        >
          {messages.tryNumber({ number: attempt.number })}
          {failed && (
            <span aria-hidden className="ms-1 text-rose">
              {messages.failedMark}
            </span>
          )}
        </button>
      ))}
    </fieldset>
  );
}
