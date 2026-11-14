import { type Quest, type Task, TaskPauses } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import type { useTaskControl } from "../../api/task-controls.ts";
import { controlError } from "../quest/control-room.ts";
import { Refusal } from "../quest/room-controls.tsx";
import { messages } from "./messages.ts";

const copy = messages.paused;

type Control = ReturnType<typeof useTaskControl>;

/** What Pause, Pause now or Resume sends for the quest's top Task (#1446): the whole quest when it is one. */
export const pauseControl = (top: Task, quest: Quest | null, now: boolean) =>
  quest === null
    ? { kind: "pause" as const, taskId: top.id, now }
    : { kind: "pauseQuest" as const, questId: quest.id, now };

const resumeControl = (top: Task, quest: Quest | null) =>
  quest === null ? { kind: "resume" as const, taskId: top.id } : { kind: "resumeQuest" as const, questId: quest.id };

/**
 * Pause and Resume in the quest's sheet (#1446). While the work runs, a quiet Pause beside Show the
 * work; Pause now is in the ⋯ menu. While it is paused, a banner says so, with Resume. Both act on
 * the quest's top Task and everything under it.
 */
export function PauseControls({
  top,
  quest,
  owner,
  control,
}: {
  top: Task;
  quest: Quest | null;
  /** The name of the hob that leads it, for a refusal's words. */
  owner: string;
  control: Control;
}) {
  const refusal = control.isError ? controlError(control.error, { owner, target: owner }) : null;
  if (TaskPauses.isPaused(top)) {
    const pausing = TaskPauses.isPausing(top);
    const title = pausing ? copy.pausing : copy.title;
    return (
      <section
        aria-label={title}
        className="order-first flex basis-full flex-wrap items-center gap-3 rounded-card border-(length:--edge) border-solid border-line-2 bg-card px-4 py-3"
      >
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="font-heading text-title font-(--heading-weight) text-text-strong">{title}</span>
          <span className="text-detail text-text-secondary">{pausing ? copy.pausingHint : copy.hint}</span>
        </span>
        <Button
          variant="outline"
          size="sm"
          title={copy.resumeHint}
          disabled={control.isPending}
          onClick={() => control.mutate(resumeControl(top, quest))}
        >
          {copy.resume}
        </Button>
        <span className="basis-full empty:hidden">
          <Refusal>{refusal}</Refusal>
        </span>
      </section>
    );
  }
  if (!TaskPauses.canPause(top)) return null;
  return (
    <>
      <Button
        variant="quiet"
        size="sm"
        title={copy.pauseHint}
        disabled={control.isPending}
        onClick={() => control.mutate(pauseControl(top, quest, false))}
      >
        {copy.pause}
      </Button>
      <Refusal>{refusal}</Refusal>
    </>
  );
}
