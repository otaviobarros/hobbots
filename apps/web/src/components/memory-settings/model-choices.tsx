import type { MemoryModelState, MemorySettings, RuntimeKind, RuntimeModels } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { runtimesQuery } from "../../api/queries.ts";
import { providerFix } from "../providers/provider-fix.tsx";
import { Choice } from "./choice.tsx";
import { messages } from "./messages.ts";
import { effortOptions, fallbackOptions, modelOptions, shownModel, stateNotes, taskOptions } from "./model.ts";

/** The parts of the memory model's settings below the provider. */

const copy = messages;

export interface ModelChoiceProps {
  readonly shown: MemorySettings;
  readonly models: RuntimeModels | undefined;
  readonly busy: boolean;
  readonly save: (next: MemorySettings) => void;
}

/** The model and effort rows, offering exactly what the provider's runtime lists. */
export function ModelRows({ shown, models, busy, save }: ModelChoiceProps) {
  const model = shownModel(shown, models);
  const offered = modelOptions(models, shown.model);
  const efforts = effortOptions(models, model);
  return (
    <>
      <span className="text-detail text-label">{copy.model.model}</span>
      {offered.length === 0 ? (
        <span className="text-detail text-text-secondary">{copy.model.noModels}</span>
      ) : (
        <Choice
          label={copy.model.model}
          value={model ?? ""}
          options={offered}
          disabled={busy}
          onPick={(picked) => save({ ...shown, model: picked })}
        />
      )}
      {efforts.length > 0 && (
        <>
          <span className="text-detail text-label">{copy.model.effort}</span>
          <Choice
            label={copy.model.effort}
            value={shown.effort}
            options={efforts}
            disabled={busy}
            onPick={(effort) => save({ ...shown, effort })}
          />
        </>
      )}
    </>
  );
}

/** A model per task, behind a toggle. */
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
          {(["summaries", "check", "answers"] as const).map((task) => (
            <div key={task} className="flex items-center gap-3 rounded-control bg-ground px-3 py-2">
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-ui">{copy.tasks.rows[task].title}</span>
                <span className="text-meta text-label">{copy.tasks.rows[task].detail}</span>
              </span>
              <Choice
                label={copy.tasks.rows[task].title}
                value={shown.tasks[task]}
                options={taskOptions(models, shown.tasks[task], task === "summaries")}
                disabled={busy}
                onPick={(choice) => save({ ...shown, tasks: { ...shown.tasks, [task]: choice } })}
              />
            </div>
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
