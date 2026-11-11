import { MEMORY_RUNTIMES, type MemoryModelVendor, type MemorySettings, type RuntimeKind } from "@hobbots/domain";
import { useQuery } from "@tanstack/react-query";
import { useId } from "react";
import { memoryOverviewQuery, useUpdateMemorySettings } from "../../api/memory.ts";
import { modelsQuery } from "../../api/queries.ts";
import {
  brainGroups,
  brainValue,
  isRecommended,
  type ModelsByVendor,
  NO_BRAIN,
  pickBrain,
  vendorOf,
} from "../memory-settings/brain.ts";
import { messages as memoryMessages } from "../memory-settings/messages.ts";
import { ModelSelect } from "../memory-settings/model-select.tsx";
import { messages } from "../messages.ts";

const copy = messages.onboarding.providers.brain;

/**
 * The brain as setup shows it: the saved choice while it runs on a connected provider, otherwise
 * the first connected provider's smallest model at low effort, which Continue then saves.
 */
export const setupBrain = (settings: MemorySettings, connected: ReadonlyArray<MemoryModelVendor>): MemorySettings => {
  const first = connected[0];
  if (first === undefined || settings.provider === "none" || connected.includes(settings.provider)) return settings;
  return pickBrain(settings, `${first}:`);
};

/**
 * The hub's brain in setup's Your AI step (ADR 037), once a provider is connected: what it shows, a
 * pick that saves at once, and `settle`, which Continue calls to save the brain setup picked.
 */
export const useOnboardingBrain = (runtimes: ReadonlyArray<RuntimeKind>) => {
  const connected = runtimes.flatMap((runtime) => {
    const vendor = vendorOf(runtime);
    return vendor === undefined ? [] : [vendor];
  });
  const saved = useQuery(memoryOverviewQuery).data?.settings;
  const update = useUpdateMemorySettings();
  const claude = useQuery({ ...modelsQuery(MEMORY_RUNTIMES.claude), enabled: connected.includes("claude") }).data;
  const chatgpt = useQuery({ ...modelsQuery(MEMORY_RUNTIMES.chatgpt), enabled: connected.includes("chatgpt") }).data;
  const models: ModelsByVendor = { claude, chatgpt };
  const base = update.isPending || update.isError ? update.variables : saved;
  const shown = base === undefined ? undefined : setupBrain(base, connected);
  const save = (next: MemorySettings) => update.mutate(next);
  return {
    connected,
    shown,
    models,
    busy: update.isPending,
    failed: update.isError,
    pick: (value: string) => shown !== undefined && save(pickBrain(shown, value)),
    settle: () => {
      if (shown !== undefined && saved !== undefined && shown !== saved && !update.isPending) save(shown);
    },
  };
};

export type OnboardingBrainState = ReturnType<typeof useOnboardingBrain>;

/** The brain's card under the connected providers: one model list, or No AI, and what it means. */
export function OnboardingBrain({ brain }: { brain: OnboardingBrainState }) {
  const headingId = useId();
  const modelId = useId();
  const { shown, connected, models } = brain;
  if (shown === undefined || connected.length === 0) return null;
  const value = brainValue(shown, models);
  const line = value === NO_BRAIN ? copy.lines.none : isRecommended(value) ? copy.lines.recommended : copy.lines.bigger;
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2.5 rounded-card bg-card p-[18px]">
      <span className="flex flex-col gap-0.5">
        <h2 id={headingId} className="m-0 text-title font-bold">
          {copy.heading}
        </h2>
        <span className="text-ui leading-5 text-text-secondary">{copy.intro}</span>
      </span>
      <span className="flex flex-wrap items-center gap-2.5">
        <label htmlFor={modelId} className="text-ui text-text-secondary">
          {copy.model}
        </label>
        <ModelSelect
          id={modelId}
          label={copy.heading}
          value={value}
          groups={brainGroups(shown, connected, models)}
          options={[{ value: NO_BRAIN, label: memoryMessages.brain.none }]}
          disabled={brain.busy}
          onPick={brain.pick}
        />
        {isRecommended(value) && (
          <span className="rounded-tag bg-mint px-2 py-0.5 text-detail font-bold text-ground">{copy.recommended}</span>
        )}
      </span>
      {brain.failed ? (
        <p role="alert" className="m-0 text-detail text-rose">
          {copy.saveFailed}
        </p>
      ) : (
        <span className="text-detail text-label">{line}</span>
      )}
    </section>
  );
}
