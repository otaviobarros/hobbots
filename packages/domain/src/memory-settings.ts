import { Schema } from "effect";
import { Effort, type RuntimeKind } from "./agent.ts";
import type { RuntimeModel, RuntimeModels } from "./runtime.ts";

/**
 * The memory model (ADR 028): the one model memory work outside a chat uses, such as summing up a
 * chat after it ends or Check now. Chosen in Settings › Your data › Memory, in Hobbots' own words.
 * It runs only through a runtime's adapter, on the sign-in that runtime already has, so its models,
 * efforts and availability are the runtime's own, as the brain picker shows them. It never depends
 * on a hob's brain.
 */

/** Who runs the memory model, or `none` for No AI: memory still works, with plain summaries. */
export const MemoryModelProvider = Schema.Literals(["claude", "chatgpt", "none"]);
export type MemoryModelProvider = typeof MemoryModelProvider.Type;

/** The providers that run a model, in the order Settings offers them. */
export type MemoryModelVendor = Exclude<MemoryModelProvider, "none">;

/** The runtime each provider's memory tasks run on, through its adapter and its sign-in. */
export const MEMORY_RUNTIMES: Readonly<Record<MemoryModelVendor, RuntimeKind>> = {
  claude: "claude-code",
  chatgpt: "codex",
};

/**
 * What memory does when the model is not available, such as when a plan runs out for the week:
 * `plain` writes summaries with no AI, `other` asks the other provider's smallest model.
 */
export const MemoryFallback = Schema.Literals(["plain", "other"]);
export type MemoryFallback = typeof MemoryFallback.Type;

/**
 * A model's id as its runtime reports it, such as `haiku` or `claude-opus-4-8[1m]`: a short plain
 * name, never a quote, space or newline, so it can be written into the memory engine's config.
 */
export const MemoryModelId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:/@[\]-]{0,127}$/));
export type MemoryModelId = typeof MemoryModelId.Type;

/** The task choice that uses the memory model itself. */
export const SAME_MEMORY_MODEL = "same";
/** The summaries choice that writes them with no AI. */
export const NO_MEMORY_MODEL = "none";

/**
 * The memory tasks that can be given their own model, each `same` as the others or a model the
 * provider's runtime offers, by its id; summing up a chat can also be `none`, summaries with no AI.
 * Searching and saving never need one.
 */
export const MemoryTasks = Schema.Struct({
  /** Summing up a chat after it ends. */
  summaries: MemoryModelId,
  /** Check now: pages that disagree or look out of date. */
  check: MemoryModelId,
  /** Answering questions about memory in plain words. */
  answers: MemoryModelId,
});
export type MemoryTasks = typeof MemoryTasks.Type;

export type MemoryTask = keyof MemoryTasks;

/**
 * The memory model as you chose it: a provider, a model id its runtime reports, or null for the
 * runtime's smallest, and an effort. With No AI the model, effort and fallback are kept as they
 * were, so turning AI back on picks up where you left it.
 */
export const MemorySettings = Schema.Struct({
  provider: MemoryModelProvider,
  model: Schema.NullOr(MemoryModelId),
  effort: Effort,
  fallback: MemoryFallback,
  tasks: MemoryTasks,
});
export type MemorySettings = typeof MemorySettings.Type;

/**
 * The choice before you make one (ADR 028): the runtime's smallest model at low effort, since
 * thinking-mode models can time out on summaries, and plain summaries when it is not available.
 */
export const DEFAULT_MEMORY_SETTINGS: MemorySettings = {
  provider: "claude",
  model: null,
  effort: "low",
  fallback: "plain",
  tasks: { summaries: SAME_MEMORY_MODEL, check: SAME_MEMORY_MODEL, answers: SAME_MEMORY_MODEL },
};

/** The other provider, which `other` falls back to. */
export const otherMemoryProvider = (provider: MemoryModelVendor): MemoryModelVendor =>
  provider === "claude" ? "chatgpt" : "claude";

/**
 * The models a runtime offers for picking, as the brain picker lists them: its main models, and
 * `keep` when it is one the runtime still lists. Its `default` row names no model of its own.
 */
export const offeredModels = (models: RuntimeModels | undefined, keep: string | null = null) =>
  (models?.models ?? []).filter((model) => model.id !== "default" && (model.main || model.id === keep));

/**
 * The runtime's smallest model: the one it names for quick work, else the last of its main models,
 * since runtimes list theirs from the most capable down. Undefined while it lists none.
 */
export const smallestModel = (models: RuntimeModels | undefined): RuntimeModel | undefined => {
  const listed = offeredModels(models);
  return listed.find((model) => model.id === models?.small) ?? listed.at(-1);
};

/**
 * The model a memory task runs on: the one asked for while the runtime offers it, otherwise its
 * smallest. `replaced` names a model asked for that the runtime no longer offers.
 */
export const memoryModelOn = (
  models: RuntimeModels | undefined,
  asked: string | null,
): { readonly model: RuntimeModel | undefined; readonly replaced: string | null } => {
  const offered = asked === null ? undefined : models?.models.find((model) => model.id === asked);
  if (offered !== undefined) return { model: offered, replaced: null };
  return { model: smallestModel(models), replaced: asked };
};

/**
 * The effort a memory task asks its model for: the one chosen when the model takes it, else the
 * lowest it takes, or none for a model that takes no effort setting.
 */
export const memoryEffortOn = (model: RuntimeModel | undefined, chosen: Effort | null): Effort | null => {
  if (model === undefined || model.efforts.length === 0) return null;
  if (chosen !== null && model.efforts.includes(chosen)) return chosen;
  return model.efforts[0] ?? null;
};

/**
 * Why the chosen provider's runtime cannot run the memory model now: its own state, as provider
 * health reports it, or `limited` when its plan's limit refused a memory task.
 */
export const MemoryModelUnavailable = Schema.Literals([
  "limited",
  "outdated",
  "signedOut",
  "unavailable",
  "unverified",
]);
export type MemoryModelUnavailable = typeof MemoryModelUnavailable.Type;

/**
 * What memory runs with now, beside what you chose: `Model` when the provider's runtime runs it,
 * with `model` the one it runs and `replaced` the model you chose when the runtime no longer offers
 * it; `NoAi` when you chose No AI; `Unavailable` when the runtime cannot run it now, so summaries
 * follow your fallback until it can.
 */
export const MemoryModelState = Schema.Union([
  Schema.TaggedStruct("Model", { model: Schema.NullOr(Schema.String), replaced: Schema.NullOr(Schema.String) }),
  Schema.TaggedStruct("NoAi", {}),
  Schema.TaggedStruct("Unavailable", {
    provider: Schema.Literals(["claude", "chatgpt"]),
    state: MemoryModelUnavailable,
    /** When a limited plan refills (ISO 8601), if the runtime said. */
    resetsAt: Schema.NullOr(Schema.String),
  }),
]);
export type MemoryModelState = typeof MemoryModelState.Type;

/**
 * How much the memory model was used since the memory engine last started, from the engine's own
 * call and token counts. It names no prompt, page or scope.
 */
export const MemoryModelUsage = Schema.Struct({
  calls: Schema.Number,
  inputTokens: Schema.Number,
  outputTokens: Schema.Number,
  /** When the engine started counting; its counts start again when it restarts. */
  since: Schema.NullOr(Schema.String),
});
export type MemoryModelUsage = typeof MemoryModelUsage.Type;
