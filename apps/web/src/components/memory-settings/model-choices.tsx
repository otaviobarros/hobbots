import type { MemoryModelState, MemorySettings, MemoryTask, RuntimeKind, RuntimeModels } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { useQuery } from "@tanstack/react-query";
import { Fragment, useId, useState } from "react";
import { runtimesQuery } from "../../api/queries.ts";
import { providerFix } from "../providers/provider-fix.tsx";
import { Choice } from "./choice.tsx";
import { messages } from "./messages.ts";
import { fallbackOptions, stateNotes, taskOptions } from "./model.ts";
import { ModelSelect } from "./model-select.tsx";

/** The parts of the hub's brain's settings below its model. */

const copy = messages;

export interface ModelChoiceProps {
  readonly shown: MemorySettings;
  readonly models: RuntimeModels | undefined;
  readonly busy: boolean;
  readonly save: (next: MemorySettings) => void;
}

/** The tasks, as Settings groups them: memory's own, then the hub's for chats and camps (ADR 037). */
const TASK_GROUPS: ReadonlyArray<{ readonly group: "memory" | "hub"; readonly tasks: ReadonlyArray<MemoryTask> }> = [
  { group: "memory", tasks: ["summaries", "check", "answers"] },
  { group: "hub", tasks: ["brief", "chapters", "judgments"] },
];

/** A model per task, behind a toggle, each from the brain's own runtime. */
export function TaskModels({ shown, models, busy, save }: ModelChoiceProps) {
  const [perTask, setPerTask] = useState(false);
  const tasksId = useId();
  return (
    <>
      <Button
        variant="ghost"
        size="xs"
        className="self-start"
        aria-expanded={perTask}
        aria-controls={tasksId}
        onClick={() => setPerTask(!perTask)}
      >
        {perTask ? copy.tasks.hide : copy.tasks.show}
      </Button>
      {perTask && (
        <div id={tasksId} className="flex flex-col gap-1">
          {TASK_GROUPS.map(({ group, tasks }) => (
            <Fragment key={group}>
              <span className="lbl pt-1 text-label">{copy.tasks.groups[group]}</span>
              {tasks.map((task) => (
                <div key={task} className="flex flex-wrap items-center gap-3 rounded-control bg-ground px-3 py-2">
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="text-ui">{copy.tasks.rows[task].title}</span>
                    <span className="text-meta text-label">{copy.tasks.rows[task].detail}</span>
                  </span>
                  <ModelSelect
                    label={copy.tasks.rows[task].title}
                    value={shown.tasks[task]}
                    options={taskOptions(models, shown.tasks[task], task !== "check" && task !== "answers")}
                    disabled={busy}
                    onPick={(choice) => save({ ...shown, tasks: { ...shown.tasks, [task]: choice } })}
                  />
                </div>
              ))}
            </Fragment>
          ))}
          <span className="text-meta text-label">{copy.tasks.note}</span>
        </div>
      )}
    </>
  );
}

/**
 * What the runtime cannot do now, with its fix, and what memory runs with when it differs. The notes
 * are about what the hub runs now, so it shows only for the provider it reports.
 */
export function ModelStatus({
  runtime,
  state,
  models,
  current,
}: {
  runtime: RuntimeKind;
  state: MemoryModelState;
  models: RuntimeModels | undefined;
  current: boolean;
}) {
  const health = useQuery(runtimesQuery).data?.find((each) => each.runtime === runtime);
  const notes = current ? stateNotes(state, models) : [];
  const fix = state._tag === "Unavailable" && state.state !== "limited" ? providerFix(runtime, health) : null;
  if (fix === null && notes.length === 0) return null;
  return (
    <span role="status" className="flex flex-col gap-0.5 text-detail text-lantern [&_code]:font-mono">
      {fix !== null && <span>{fix}</span>}
      {notes.map((note) => (
        <span key={note}>{note}</span>
      ))}
    </span>
  );
}

/** A choice the hub could not save, with Try again and Keep the one before. */
export function SaveFailed({ retry, keep }: { retry: () => void; keep: () => void }) {
  return (
    <span className="flex flex-wrap items-center gap-2">
      <p role="alert" className="m-0 text-ui text-rose">
        {copy.model.saveFailed}
      </p>
      <Button variant="ghost" size="xs" onClick={retry}>
        {copy.model.retry}
      </Button>
      <Button variant="ghost" size="xs" onClick={keep}>
        {copy.model.keepBefore}
      </Button>
    </span>
  );
}

/** What memory does when the model is not available; `models` are the other provider's. */
export function FallbackChoice({ shown, models, busy, save }: ModelChoiceProps) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-ui font-semibold">{copy.fallback.title}</span>
      <Choice
        label={copy.fallback.title}
        value={shown.fallback}
        options={fallbackOptions(shown.provider, models)}
        disabled={busy}
        onPick={(fallback) => save({ ...shown, fallback })}
      />
      <span className="text-detail text-text-secondary">{copy.fallback.note}</span>
    </div>
  );
}
