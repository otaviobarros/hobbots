import type { MemorySettings } from "@hobbots/domain";
import { Badge } from "@hobbots/ui/components/badge";
import { Button } from "@hobbots/ui/components/button";
import { SegmentedControl, SegmentedControlItem } from "@hobbots/ui/components/segmented-control";
import { Skeleton } from "@hobbots/ui/components/skeleton";
import { cn } from "@hobbots/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { memoryOverviewQuery, useUpdateMemorySettings } from "../../api/memory.ts";
import { messages } from "./messages.ts";
import {
  type ChoiceOption,
  engineTag,
  fallbackOptions,
  keptLine,
  modelHint,
  modelOptions,
  providerOptions,
  stateNote,
  taskOptions,
  withProvider,
} from "./model.ts";

const copy = messages;

/**
 * Settings › Your data › Memory (ADR 028): whether the memory engine runs and what it keeps, Show
 * the files on the desktop app, and the memory model. Each choice is stored on the hub at once,
 * which restarts only the memory engine. Until the hub answers, still lines hold the card's place.
 */
export function MemorySettingsCard() {
  const overview = useQuery(memoryOverviewQuery);
  const data = overview.data;
  const tag = data && engineTag(data.engine);
  return (
    <section
      id="memory"
      aria-label={copy.card.label}
      className="flex scroll-mt-4 flex-col gap-3.5 rounded-card bg-card p-4"
    >
      <span className="flex items-center gap-2.5">
        <strong className="flex-1 text-text-strong">{copy.card.label}</strong>
        {tag && <Badge variant={tag.variant}>{tag.label}</Badge>}
      </span>
      {overview.isError && !data ? (
        <p role="alert" className="m-0 text-ui text-rose">
          {copy.card.failed}
        </p>
      ) : data === undefined ? (
        <span aria-busy className="flex flex-col gap-2">
          <Skeleton surface="card" width="48ch" className="max-w-full" />
          <Skeleton surface="card" width="32ch" className="max-w-full" />
        </span>
      ) : (
        <>
          <span className="text-ui text-text-secondary">{keptLine(data)}</span>
          <InAChat />
          <MemoryModel settings={data.settings} note={stateNote(data.state)} />
          <CardFooter version={data.engine?.version ?? null} />
        </>
      )}
    </section>
  );
}

/** Notes saved during a chat use each hob's own model, so this setting is not about them. */
function InAChat() {
  return (
    <div className="flex items-start gap-3 rounded-control bg-ground px-3 py-2.5">
      <svg
        aria-hidden="true"
        viewBox="0 0 16 16"
        width={16}
        height={16}
        className="mt-0.5 flex-none text-mint"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" />
      </svg>
      <span className="flex flex-col gap-0.5">
        <span className="text-ui">
          <b>{copy.chat.title}</b>
          {copy.chat.body}
        </span>
        <span className="text-detail text-text-secondary">{copy.chat.note}</span>
      </span>
    </div>
  );
}

/** A segmented choice whose unavailable segments say why on hover. */
function Choice<Value extends string>({
  label,
  value,
  options,
  disabled,
  onPick,
}: {
  label: string;
  value: Value;
  options: ReadonlyArray<ChoiceOption<Value>>;
  disabled: boolean;
  onPick: (value: Value) => void;
}) {
  return (
    <SegmentedControl size="sm" aria-label={label} value={value} onValueChange={onPick}>
      {options.map((option) => (
        <SegmentedControlItem
          key={option.value}
          value={option.value}
          disabled={disabled || option.unavailable !== undefined}
          title={option.unavailable ?? option.label}
        >
          {option.label}
        </SegmentedControlItem>
      ))}
    </SegmentedControl>
  );
}

/**
 * Provider, model and effort, the hint under them, what memory runs with when it differs, the
 * fallback and, behind a toggle, a model per task. A pending change shows at once.
 */
function MemoryModel({ settings, note }: { settings: MemorySettings; note: string | null }) {
  const update = useUpdateMemorySettings();
  const [perTask, setPerTask] = useState(false);
  const tasksId = useId();
  const shown = update.isPending ? update.variables : settings;
  const save = (next: MemorySettings) => update.mutate(next);
  const hint = modelHint(shown);
  const busy = update.isPending;
  return (
    <>
      <div className="flex flex-col gap-2.5">
        <span className="flex flex-col gap-0.5">
          <span className="text-ui font-semibold">{copy.model.title}</span>
          <span className="text-detail text-text-secondary">{copy.model.intro}</span>
        </span>
        <div className="grid grid-cols-[90px_minmax(0,1fr)] items-center gap-x-3 gap-y-2.5">
          <span className="text-detail text-label">{copy.model.provider}</span>
          <Choice
            label={copy.model.provider}
            value={shown.provider}
            options={providerOptions}
            disabled={busy}
            onPick={(provider) => provider !== "gemini" && save(withProvider(shown, provider))}
          />
          {shown.provider !== "none" && (
            <>
              <span className="text-detail text-label">{copy.model.model}</span>
              <Choice
                label={copy.model.model}
                value={shown.model}
                options={modelOptions(shown.provider)}
                disabled={busy}
                onPick={(model) => save({ ...shown, model })}
              />
              <span className="text-detail text-label">{copy.model.effort}</span>
              <Choice
                label={copy.model.effort}
                value={shown.effort}
                options={(["low", "medium", "high"] as const).map((value) => ({
                  value,
                  label: copy.model.efforts[value],
                }))}
                disabled={busy}
                onPick={(effort) => save({ ...shown, effort })}
              />
            </>
          )}
        </div>
        <span className={cn("text-detail", hint.warn ? "text-lantern" : "text-text-secondary")}>{hint.text}</span>
        {note !== null && <span className="text-detail text-text-secondary">{note}</span>}
        {update.isError && (
          <p role="alert" className="m-0 text-ui text-rose">
            {copy.model.saveFailed}
          </p>
        )}
      </div>
      {shown.provider !== "none" && (
        <div className="flex flex-col gap-1.5">
          <span className="text-ui font-semibold">{copy.fallback.title}</span>
          <Choice
            label={copy.fallback.title}
            value={shown.fallback}
            options={fallbackOptions(shown.provider)}
            disabled={busy}
            onPick={(fallback) => save({ ...shown, fallback })}
          />
          <span className="text-detail text-text-secondary">{copy.fallback.note}</span>
        </div>
      )}
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
                options={taskOptions(shown.provider, task === "summaries")}
                disabled={busy}
                onPick={(choice) =>
                  save({
                    ...shown,
                    tasks: { ...shown.tasks, [task]: task === "summaries" || choice !== "none" ? choice : "same" },
                  })
                }
              />
            </div>
          ))}
          <span className="text-meta text-label">{copy.tasks.note}</span>
        </div>
      )}
      <span className="text-meta text-label">{copy.model.applies}</span>
    </>
  );
}

/** Show the files, on the desktop app on the hub, and which engine keeps memory. */
function CardFooter({ version }: { version: string | null }) {
  const showFiles = window.hobbots?.showMemoryFiles;
  return (
    <>
      {showFiles !== undefined && (
        <div className="flex flex-wrap gap-2 border-t border-line pt-3">
          <Button variant="ghost" size="sm" onClick={() => void showFiles()}>
            {copy.card.showFiles}
          </Button>
        </div>
      )}
      {version !== null && <span className="text-meta text-label">{copy.card.engine({ version })}</span>}
    </>
  );
}
