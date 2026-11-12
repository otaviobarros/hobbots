import {
  MEMORY_RUNTIMES,
  type MemoryModelState,
  type MemoryModelVendor,
  type MemorySettings,
  otherMemoryProvider,
} from "@hobbots/domain";
import { Badge } from "@hobbots/ui/components/badge";
import { Button } from "@hobbots/ui/components/button";
import { useQuery } from "@tanstack/react-query";
import { useId } from "react";
import { useUpdateMemorySettings } from "../../api/memory.ts";
import { modelsQuery } from "../../api/queries.ts";
import { setupQuery } from "../../api/setup.ts";
import { brainGroups, brainValue, NO_BRAIN, pickBrain, vendorOf } from "./brain.ts";
import { messages } from "./messages.ts";
import { effortNote, modelHint } from "./model.ts";
import { FallbackChoice, ModelStatus, SaveFailed, TaskModels } from "./model-choices.tsx";
import { ModelSelect } from "./model-select.tsx";
import { OverviewCard } from "./overview-card.tsx";

const copy = messages;

/**
 * Settings › Your data › The hub's brain (ADR 028, ADR 037): the one model the hub's own work runs
 * on, picked from one list of every connected runtime's models, or No AI. Each choice is stored on
 * the hub at once, which restarts only the memory engine. Until the hub answers, still lines hold
 * the card's place.
 */
export function HubBrainCard() {
  return (
    <OverviewCard
      id="brain"
      label={copy.brain.label}
      intro={copy.brain.intro}
      tag={({ settings }) =>
        settings.provider === "none" ? (
          <Badge variant="muted">{copy.brain.none}</Badge>
        ) : (
          <Badge variant="running">{copy.model.providers[settings.provider]}</Badge>
        )
      }
    >
      {(data) => <BrainChoices settings={data.settings} state={data.state} />}
    </OverviewCard>
  );
}

/**
 * The model, from one list grouped by provider, the effort it runs at, the hint under it, what the
 * brain runs with when it differs, the fallback and, behind a toggle, a model per task. A pending
 * change shows at once.
 */
function BrainChoices({ settings, state }: { settings: MemorySettings; state: MemoryModelState }) {
  const update = useUpdateMemorySettings();
  // A choice shows at once and stays shown when it could not be saved, so it can be sent again.
  const failed = update.isError ? update.variables : undefined;
  const shown = (update.isPending ? update.variables : failed) ?? settings;
  const vendor = shown.provider === "none" ? null : shown.provider;
  const connected = (useQuery(setupQuery).data?.connectedProviders ?? []).flatMap((runtime) => {
    const each = vendorOf(runtime);
    return each === undefined ? [] : [each];
  });
  // A runtime's models are asked for when the list shows them, or the fallback names its smallest.
  const listed = (each: MemoryModelVendor) =>
    connected.includes(each) || shown.provider === each || shown.fallback === "other";
  const claude = useQuery({ ...modelsQuery(MEMORY_RUNTIMES.claude), enabled: listed("claude") }).data;
  const chatgpt = useQuery({ ...modelsQuery(MEMORY_RUNTIMES.chatgpt), enabled: listed("chatgpt") }).data;
  const byVendor = { claude, chatgpt };
  const models = vendor === null ? undefined : byVendor[vendor];
  const otherModels = vendor === null ? undefined : byVendor[otherMemoryProvider(vendor)];
  const save = (next: MemorySettings) => update.mutate(next);
  const busy = update.isPending;
  const effort = effortNote(shown, models);
  const modelId = useId();
  return (
    <>
      <div className="flex flex-col gap-2.5">
        <span className="flex flex-wrap items-center gap-3">
          <label htmlFor={modelId} className="text-detail text-label">
            {copy.brain.model}
          </label>
          <ModelSelect
            id={modelId}
            label={copy.brain.label}
            value={brainValue(shown, byVendor)}
            groups={brainGroups(shown, connected, byVendor)}
            options={[{ value: NO_BRAIN, label: copy.brain.none }]}
            disabled={busy}
            onPick={(value) => save(pickBrain(shown, value))}
          />
        </span>
        {effort !== null && (
          <span className="flex flex-wrap items-center gap-2 text-detail text-text-secondary">
            {effort.text}
            {effort.lower && (
              <Button variant="ghost" size="xs" disabled={busy} onClick={() => save({ ...shown, effort: "low" })}>
                {copy.brain.effort.useLow}
              </Button>
            )}
          </span>
        )}
        <span className="text-detail text-text-secondary">{modelHint(shown, models)}</span>
        {vendor !== null && (
          <ModelStatus
            runtime={MEMORY_RUNTIMES[vendor]}
            state={state}
            models={models}
            current={vendor === settings.provider}
          />
        )}
        {failed !== undefined && <SaveFailed retry={() => save(failed)} keep={() => update.reset()} />}
      </div>
      {vendor !== null && <FallbackChoice shown={shown} models={otherModels} busy={busy} save={save} />}
      <TaskModels shown={shown} models={models} busy={busy || vendor === null} save={save} />
      <span className="text-meta text-label">{copy.model.applies}</span>
    </>
  );
}
