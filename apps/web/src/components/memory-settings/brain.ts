import {
  MEMORY_RUNTIMES,
  type MemoryModelVendor,
  type MemorySettings,
  offeredModels,
  type RuntimeKind,
  type RuntimeModels,
  smallestModel,
} from "@hobbots/domain";
import { messages } from "./messages.ts";
import { type ChoiceOption, withProvider } from "./model.ts";

/**
 * The hub's brain as one choice (ADR 037): a model on any connected runtime, or No AI. A choice is
 * `provider:model`, where an empty model is the runtime's smallest, so the brain follows the runtime
 * when its smallest changes. Every pick runs at low effort, which is enough for the brain's work.
 */

const copy = messages;

/** The providers that run a model, in the order the brain lists them. */
const BRAIN_VENDORS: ReadonlyArray<MemoryModelVendor> = ["claude", "chatgpt"];

/** The provider whose model runs on a runtime, if any does. */
export const vendorOf = (runtime: RuntimeKind): MemoryModelVendor | undefined =>
  BRAIN_VENDORS.find((vendor) => MEMORY_RUNTIMES[vendor] === runtime);

/** The choice that turns the brain off. */
export const NO_BRAIN = "none";

/** One provider's models in the brain's list. */
export interface BrainGroup {
  readonly label: string;
  readonly options: ReadonlyArray<ChoiceOption<string>>;
}

export type ModelsByVendor = Readonly<Partial<Record<MemoryModelVendor, RuntimeModels | undefined>>>;

const choiceOf = (vendor: MemoryModelVendor, model: string | null) => `${vendor}:${model ?? ""}`;

/** The brain's choice as its list names it: the smallest of a runtime reads as that runtime's own. */
export const brainValue = (settings: MemorySettings, models: ModelsByVendor): string => {
  if (settings.provider === "none") return NO_BRAIN;
  const smallest = smallestModel(models[settings.provider])?.id;
  return choiceOf(settings.provider, settings.model === smallest ? null : settings.model);
};

/** Whether a choice is a runtime's smallest model, which the brain recommends. */
export const isRecommended = (value: string) => value !== NO_BRAIN && value.endsWith(":");

/**
 * Each provider's models, for the connected ones and the one chosen: its smallest first and
 * marked recommended, then the rest as the runtime lists them, and a chosen model it stopped
 * offering, marked. A runtime that lists no models yet still offers its smallest.
 */
export const brainGroups = (
  settings: MemorySettings,
  connected: ReadonlyArray<MemoryModelVendor>,
  models: ModelsByVendor,
): ReadonlyArray<BrainGroup> => {
  const shown = BRAIN_VENDORS.filter((vendor) => connected.includes(vendor) || settings.provider === vendor);
  return shown.map((vendor) => {
    const listed = models[vendor];
    const chosen = settings.provider === vendor ? settings.model : null;
    const smallest = smallestModel(listed);
    const offered = offeredModels(listed, chosen).filter((model) => model.id !== smallest?.id);
    // Until the runtime answers, a chosen model shows by its id; once it answers, one it dropped is marked.
    const gone =
      chosen !== null && chosen !== smallest?.id && !offered.some((m) => m.id === chosen)
        ? [
            {
              value: choiceOf(vendor, chosen),
              label: listed === undefined ? chosen : copy.tasks.gone({ model: chosen }),
            },
          ]
        : [];
    return {
      label: copy.model.providers[vendor],
      options: [
        {
          value: choiceOf(vendor, null),
          label: copy.brain.recommended({ model: smallest?.displayName ?? copy.brain.smallest }),
        },
        ...offered.map((model) => ({ value: choiceOf(vendor, model.id), label: model.displayName })),
        ...gone,
      ],
    };
  });
};

/**
 * The settings with the brain on a choice from its list, at low effort. Another provider starts its
 * tasks over on the same model, since a model belongs to one runtime; No AI keeps the rest as it was.
 */
export const pickBrain = (settings: MemorySettings, value: string): MemorySettings => {
  if (value === NO_BRAIN) return withProvider(settings, "none");
  const split = value.indexOf(":");
  const vendor = BRAIN_VENDORS.find((each) => each === value.slice(0, split));
  if (vendor === undefined) return settings;
  const model = value.slice(split + 1);
  return { ...withProvider(settings, vendor), model: model === "" ? null : model, effort: "low" };
};
