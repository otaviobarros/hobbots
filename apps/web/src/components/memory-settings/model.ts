import type { MemoryOverview } from "@hobbots/api";
import {
  type Effort,
  type MemoryEngineHealth,
  type MemoryModelProvider,
  type MemoryModelState,
  type MemoryModelUsage,
  type MemorySettings,
  NO_MEMORY_MODEL,
  offeredModels,
  otherMemoryProvider,
  type RuntimeModels,
  SAME_MEMORY_MODEL,
  type SafetyPreset,
  smallestModel,
} from "@hobbots/domain";
import { effortWords } from "../../api/first-hob.ts";
import { formatBytes, formatCompact, formatCount, formatMoment, plural } from "../../lib/format.ts";
import { RUNTIME_STATE_WORDS } from "../../lib/providers.ts";
import { messages } from "./messages.ts";

const copy = messages;

/** One segment of a choice: its value, its words, and why it can't be picked when it can't. */
export interface ChoiceOption<Value extends string> {
  readonly value: Value;
  readonly label: string;
  /** Set when the segment can't be picked. */
  readonly unavailable?: string;
}

/** The model memory runs on: the one chosen, or the runtime's smallest while none is. */
export const shownModel = (settings: MemorySettings, models: RuntimeModels | undefined): string | null =>
  settings.model ?? smallestModel(models)?.id ?? null;

/**
 * The models the provider's runtime offers, exactly as the brain picker lists them, and the one
 * chosen while the runtime still lists it.
 */
export const modelOptions = (models: RuntimeModels | undefined, chosen: string | null) =>
  offeredModels(models, chosen).map((model): ChoiceOption<string> => ({ value: model.id, label: model.displayName }));

/** The efforts the shown model takes, in the runtime's words; none for a model that takes none. */
export const effortOptions = (models: RuntimeModels | undefined, model: string | null) =>
  (models?.models.find((listed) => listed.id === model)?.efforts ?? []).map(
    (effort): ChoiceOption<Effort> => ({ value: effort, label: effortWords(effort).label }),
  );

/**
 * The settings with another provider: its runtime's smallest model, and tasks back on the same
 * model, since a model belongs to one runtime. No AI keeps everything, so turning AI back on picks
 * up where you left it.
 */
export const withProvider = (settings: MemorySettings, provider: MemoryModelProvider): MemorySettings => {
  if (provider === "none" || settings.provider === "none" || provider === settings.provider)
    return { ...settings, provider };
  const same = (choice: string) => (choice === NO_MEMORY_MODEL ? choice : SAME_MEMORY_MODEL);
  return {
    ...settings,
    provider,
    model: null,
    tasks: {
      summaries: same(settings.tasks.summaries),
      check: SAME_MEMORY_MODEL,
      answers: SAME_MEMORY_MODEL,
      brief: same(settings.tasks.brief),
      chapters: same(settings.tasks.chapters),
      judgments: same(settings.tasks.judgments),
    },
  };
};

/** The line under the model: what No AI means, or which sign-in it uses and what its size costs. */
export const modelHint = (settings: MemorySettings, models: RuntimeModels | undefined): string => {
  if (settings.provider === "none") return copy.model.hints.none;
  const smallest = smallestModel(models)?.id;
  const size =
    settings.model === null || settings.model === smallest ? copy.model.hints.small : copy.model.hints.bigger;
  return `${copy.model.hints[settings.provider]} ${size}`;
};

/**
 * What effort the brain runs at, for a model that takes one: low, which this work needs, or the
 * effort chosen before, with the offer to go back to low.
 */
export const effortNote = (
  settings: MemorySettings,
  models: RuntimeModels | undefined,
): { readonly text: string; readonly lower: boolean } | null => {
  if (settings.provider === "none" || effortOptions(models, shownModel(settings, models)).length === 0) return null;
  if (settings.effort === "low") return { text: copy.brain.effort.low, lower: false };
  return { text: copy.brain.effort.other({ effort: effortWords(settings.effort).label.toLowerCase() }), lower: true };
};

/** The model's name as the runtime gives it, or its id when the runtime does not list it. */
const nameOf = (models: RuntimeModels | undefined, id: string) =>
  models?.models.find((model) => model.id === id)?.displayName ?? id;

/** What each model memory runs in place of one you chose says: the memory model's, then each task's. */
const replacedNotes = (state: Extract<MemoryModelState, { _tag: "Model" }>, models: RuntimeModels | undefined) => {
  const instead = (model: string | null) => (model === null ? null : nameOf(models, model));
  const main = instead(state.model);
  return [
    ...(state.replaced === null || main === null ? [] : [copy.model.replaced({ chosen: state.replaced, model: main })]),
    ...state.tasks.flatMap(({ task, replaced, model }) => {
      const used = instead(model);
      return used === null
        ? []
        : [copy.model.taskReplaced({ task: copy.tasks.rows[task].title, chosen: replaced, model: used })];
    }),
  ];
};

/**
 * What memory runs with when it is not the model you chose, for the memory model and for each task
 * given its own, or why it can't run it now; none when it runs what you chose. A runtime that is
 * signed out or missing says how to fix it on its own.
 */
export const stateNotes = (
  state: MemoryModelState,
  models: RuntimeModels | undefined,
  locale?: string,
): ReadonlyArray<string> => {
  if (state._tag === "Model") return replacedNotes(state, models);
  if (state._tag !== "Unavailable") return [];
  const provider = copy.model.providers[state.provider];
  if (state.state !== "limited") return [copy.model.notReady];
  return [
    state.resetsAt === null
      ? copy.model.limited({ provider })
      : copy.model.limitedUntil({ provider, until: formatMoment(state.resetsAt, locale) }),
  ];
};

/** The fallback choices, with the other provider's smallest model named when its runtime lists it. */
export const fallbackOptions = (
  provider: MemoryModelProvider,
  otherModels: RuntimeModels | undefined,
): ReadonlyArray<ChoiceOption<"plain" | "other">> => {
  const other = provider === "none" ? null : otherMemoryProvider(provider);
  const smallest = smallestModel(otherModels)?.displayName;
  return [
    { value: "plain", label: copy.fallback.options.plain },
    {
      value: "other",
      label: copy.fallback.options.other({
        other:
          other === null
            ? copy.model.providers.chatgpt
            : [copy.model.providers[other], smallest].filter((part) => part !== undefined).join(" "),
      }),
      ...(other === null && { unavailable: copy.tasks.pickFirst }),
    },
  ];
};

/** A task's choices: the same model, each model the runtime offers, and for summaries No AI. */
export const taskOptions = (
  models: RuntimeModels | undefined,
  chosen: string,
  withNone: boolean,
): ReadonlyArray<ChoiceOption<string>> => {
  const own = chosen === SAME_MEMORY_MODEL || chosen === NO_MEMORY_MODEL ? null : chosen;
  const offered = modelOptions(models, own);
  // A model the runtime stopped offering stays shown as chosen, marked, until you pick another.
  const gone =
    own !== null && models !== undefined && !offered.some((option) => option.value === own)
      ? [{ value: own, label: copy.tasks.gone({ model: own }) }]
      : [];
  return [
    { value: SAME_MEMORY_MODEL, label: copy.tasks.same },
    ...offered,
    ...gone,
    ...(withNone ? [{ value: NO_MEMORY_MODEL, label: copy.tasks.none }] : []),
  ];
};

/** The engine's state as the card's tag says it, and the tag's look. */
export const engineTag = (
  engine: MemoryEngineHealth | null,
): { readonly label: string; readonly variant: "running" | "waiting" | "muted" } => {
  if (engine === null) return { label: copy.card.states.off, variant: "muted" };
  const variant = engine.state === "running" ? "running" : engine.state === "off" ? "muted" : "waiting";
  return { label: copy.card.states[engine.state], variant };
};

/** The card's first line: how many pages and how much room, or why memory is off. */
export const keptLine = (overview: Pick<MemoryOverview, "engine" | "pages" | "bytes">, locale?: string): string => {
  const engine = overview.engine;
  if (engine === null) return copy.card.off.disabled;
  if (engine.state === "off") return copy.card.off[engine.offReason ?? "disabled"];
  const pages =
    overview.pages === null
      ? null
      : plural(
          overview.pages,
          { one: copy.card.pages.one, other: copy.card.pages.other(formatCount(overview.pages, locale)) },
          locale,
        );
  return copy.card.kept({ pages, size: overview.bytes === null ? null : formatBytes(overview.bytes, locale) });
};

/**
 * How a share follows the preset (ADR 028): Careful and Balanced ask, Trusting lets a project share
 * through, and About you asks under every preset.
 */
export const shareAnswer = (preset: SafetyPreset, scope: "project" | "everyone"): "ask" | "through" =>
  scope === "project" && preset === "trusting" ? "through" : "ask";

/** Usage's Memory line: the model's calls and tokens, or why it makes none. */
export const usageLine = (
  overview: Pick<MemoryOverview, "state" | "usage"> | undefined,
  locale?: string,
): string | null => {
  if (overview === undefined) return null;
  const state = overview.state;
  if (state._tag === "NoAi") return copy.usage.noAi;
  if (state._tag === "Unavailable")
    return copy.usage.unavailable({
      provider: copy.model.providers[state.provider],
      state: state.state === "limited" ? copy.usage.limited : RUNTIME_STATE_WORDS[state.state],
    });
  return overview.usage === null ? copy.usage.unknown : callsLine(overview.usage, locale);
};

/**
 * Usage's line for the hub's brain's own turns (ADR 037), which the memory engine never counts;
 * none until it has made one.
 */
export const hubUsageLine = (overview: Pick<MemoryOverview, "hubUsage"> | undefined, locale?: string) => {
  const usage = overview?.hubUsage;
  if (usage === undefined || usage === null || usage.calls === 0) return null;
  return callsLine(usage, locale, copy.usage.hubCalls);
};

const callsLine = (usage: MemoryModelUsage, locale?: string, line = copy.usage.calls) =>
  line({
    calls: plural(
      usage.calls,
      { one: copy.usage.callCount.one, other: copy.usage.callCount.other(formatCount(usage.calls, locale)) },
      locale,
    ),
    tokens: copy.usage.tokens({ count: formatCompact(usage.inputTokens + usage.outputTokens, locale) }),
  });
