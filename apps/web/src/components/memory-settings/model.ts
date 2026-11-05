import type { MemoryOverview } from "@hobbots/api";
import {
  MEMORY_MODELS,
  type MemoryEngineHealth,
  type MemoryModelName,
  type MemoryModelProvider,
  type MemoryModelState,
  type MemoryModelUsage,
  type MemorySettings,
  memoryModelOffered,
  otherMemoryProvider,
  type SafetyPreset,
  STRONGER_MEMORY_MODEL,
} from "@hobbots/domain";
import { formatBytes, formatCompact, formatCount, plural } from "../../lib/format.ts";
import { messages } from "./messages.ts";

const copy = messages;

/** One segment of a choice: its value, its words, and why it can't be picked when it can't. */
export interface ChoiceOption<Value extends string> {
  readonly value: Value;
  readonly label: string;
  /** Set when the segment can't be picked. */
  readonly unavailable?: string;
}

/** The providers in the order Settings offers them. Gemini shows, waiting for a later update. */
export const providerOptions: ReadonlyArray<ChoiceOption<MemoryModelProvider | "gemini">> = [
  { value: "claude", label: copy.model.providers.claude },
  { value: "chatgpt", label: copy.model.providers.chatgpt },
  { value: "gemini", label: copy.model.providers.gemini, unavailable: copy.model.geminiLater },
  { value: "none", label: copy.model.providers.none },
];

/** The models the chosen provider offers; none for No AI. */
export const modelOptions = (provider: MemoryModelProvider): ReadonlyArray<ChoiceOption<MemoryModelName>> =>
  provider === "none" ? [] : MEMORY_MODELS[provider].map((value) => ({ value, label: copy.model.models[value] }));

/**
 * The settings with another provider: its first model when the one chosen is not its own. No AI
 * keeps the model, so turning AI back on picks up where you left it.
 */
export const withProvider = (settings: MemorySettings, provider: MemoryModelProvider): MemorySettings => {
  if (provider === "none" || memoryModelOffered(provider, settings.model)) return { ...settings, provider };
  return { ...settings, provider, model: MEMORY_MODELS[provider][0] };
};

/** The line under the model: what No AI means, a warning about high effort, or how it signs in. */
export const modelHint = (settings: MemorySettings): { readonly text: string; readonly warn: boolean } => {
  if (settings.provider === "none") return { text: copy.model.hints.none, warn: false };
  if (settings.effort === "high") return { text: copy.model.hints.high, warn: true };
  const size = settings.model === "opus" ? copy.model.hints.opus : copy.model.hints.small;
  return { text: `${copy.model.hints[settings.provider]} ${size}`, warn: false };
};

/** What memory runs with when it is not the model you chose; null when it is. */
export const stateNote = (state: MemoryModelState): string | null =>
  state._tag === "NeedsKey" ? copy.model.needsKey({ provider: copy.model.providers[state.provider] }) : null;

/** The fallback choices, with the other provider's small model named. */
export const fallbackOptions = (provider: MemoryModelProvider): ReadonlyArray<ChoiceOption<"plain" | "other">> => {
  const other = provider === "none" ? null : otherMemoryProvider(provider);
  return [
    { value: "plain", label: copy.fallback.options.plain },
    {
      value: "other",
      label: copy.fallback.options.other({
        other:
          other === null
            ? copy.model.providers.chatgpt
            : `${copy.model.providers[other]} ${copy.model.models[MEMORY_MODELS[other][0]]}`,
      }),
      ...(other === null && { unavailable: copy.tasks.pickFirst }),
    },
  ];
};

/** A task's choices: the same model, the provider's stronger one, and for summaries No AI. */
export const taskOptions = (
  provider: MemoryModelProvider,
  withNone: boolean,
): ReadonlyArray<ChoiceOption<"same" | "stronger" | "none">> => [
  { value: "same", label: copy.tasks.same },
  provider === "none"
    ? { value: "stronger", label: copy.model.models.sonnet, unavailable: copy.tasks.pickFirst }
    : { value: "stronger", label: copy.model.models[STRONGER_MEMORY_MODEL[provider]] },
  ...(withNone ? [{ value: "none" as const, label: copy.tasks.none }] : []),
];

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
  if (overview.state._tag === "NoAi") return copy.usage.noAi;
  if (overview.state._tag === "NeedsKey") return copy.usage.needsKey;
  return overview.usage === null ? copy.usage.unknown : callsLine(overview.usage, locale);
};

const callsLine = (usage: MemoryModelUsage, locale?: string) =>
  copy.usage.calls({
    calls: plural(
      usage.calls,
      { one: copy.usage.callCount.one, other: copy.usage.callCount.other(formatCount(usage.calls, locale)) },
      locale,
    ),
    tokens: copy.usage.tokens({ count: formatCompact(usage.inputTokens + usage.outputTokens, locale) }),
  });
