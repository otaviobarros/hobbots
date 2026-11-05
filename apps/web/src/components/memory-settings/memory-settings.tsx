import { MEMORY_RUNTIMES, type MemoryModelState, type MemorySettings } from "@hobbots/domain";
import { Badge } from "@hobbots/ui/components/badge";
import { Skeleton } from "@hobbots/ui/components/skeleton";
import { cn } from "@hobbots/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { memoryOverviewQuery, useUpdateMemorySettings } from "../../api/memory.ts";
import { modelsQuery } from "../../api/queries.ts";
import { CardFooter } from "./card-footer.tsx";
import { Choice } from "./choice.tsx";
import { messages } from "./messages.ts";
import { engineTag, keptLine, modelHint, otherRuntime, providerOptions, withProvider } from "./model.ts";
import { FallbackChoice, ModelRows, ModelStatus, SaveFailed, TaskModels } from "./model-choices.tsx";

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
          <MemoryModel settings={data.settings} state={data.state} />
          <CardFooter version={data.engine?.version ?? null} />
        </>
      )}
    </section>
  );
}

/** A hob saves notes during its own reply, with no extra model call, so this setting is not about them. */
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

/**
 * Provider, model and effort, from the provider's runtime as the brain picker lists them, the hint
 * under them, what memory runs with when it differs, the fallback and, behind a toggle, a model per
 * task. A pending change shows at once.
 */
function MemoryModel({ settings, state }: { settings: MemorySettings; state: MemoryModelState }) {
  const update = useUpdateMemorySettings();
  // A choice shows at once and stays shown when it could not be saved, so it can be sent again.
  const failed = update.isError ? update.variables : undefined;
  const shown = (update.isPending ? update.variables : failed) ?? settings;
  const vendor = shown.provider === "none" ? null : shown.provider;
  const runtime = MEMORY_RUNTIMES[vendor ?? "claude"];
  const models = useQuery({ ...modelsQuery(runtime), enabled: vendor !== null }).data;
  const otherModels = useQuery({ ...modelsQuery(otherRuntime(vendor ?? "claude")), enabled: vendor !== null }).data;
  const save = (next: MemorySettings) => update.mutate(next);
  const busy = update.isPending;
  const hint = modelHint(shown, models);
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
          {vendor !== null && <ModelRows shown={shown} models={models} busy={busy} save={save} />}
        </div>
        <span className={cn("text-detail", hint.warn ? "text-lantern" : "text-text-secondary")}>{hint.text}</span>
        {vendor !== null && (
          <ModelStatus runtime={runtime} state={state} models={models} current={vendor === settings.provider} />
        )}
        {failed !== undefined && <SaveFailed retry={() => save(failed)} keep={() => update.reset()} />}
      </div>
      {vendor !== null && <FallbackChoice shown={shown} models={otherModels} busy={busy} save={save} />}
      <TaskModels shown={shown} models={models} busy={busy || vendor === null} save={save} />
      <span className="text-meta text-label">{copy.model.applies}</span>
    </>
  );
}
