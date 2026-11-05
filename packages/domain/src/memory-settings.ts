import { Schema } from "effect";

/**
 * The memory model (ADR 028): the one model memory work outside a chat uses, such as summing up a
 * chat after it ends or Check now. Chosen in Settings › Your data › Memory, in Hobbots' own words;
 * the memory adapter turns it into its engine's provider settings. It never depends on a hob's
 * brain or runtime.
 */

/** Who runs the memory model, or `none` for No AI: memory still works, with plain summaries. */
export const MemoryModelProvider = Schema.Literals(["claude", "chatgpt", "none"]);
export type MemoryModelProvider = typeof MemoryModelProvider.Type;

/** The providers that run a model, in the order Settings offers them. */
export type MemoryModelVendor = Exclude<MemoryModelProvider, "none">;

/** The models Settings offers per provider, smallest first; the first is the default. */
export const MEMORY_MODELS = {
  claude: ["haiku", "sonnet", "opus"],
  chatgpt: ["mini", "gpt-5.5"],
} as const satisfies Record<MemoryModelVendor, ReadonlyArray<string>>;

export const MemoryModelName = Schema.Literals(["haiku", "sonnet", "opus", "mini", "gpt-5.5"]);
export type MemoryModelName = typeof MemoryModelName.Type;

/** Each provider's stronger model, for a task that is given one. */
export const STRONGER_MEMORY_MODEL: Readonly<Record<MemoryModelVendor, MemoryModelName>> = {
  claude: "sonnet",
  chatgpt: "gpt-5.5",
};

/** How hard the memory model thinks. Shared by every memory task. */
export const MemoryEffort = Schema.Literals(["low", "medium", "high"]);
export type MemoryEffort = typeof MemoryEffort.Type;

/**
 * What memory does when the model is not available, such as when a plan runs out for the week:
 * `plain` writes summaries with no AI, `other` asks the other provider's small model.
 */
export const MemoryFallback = Schema.Literals(["plain", "other"]);
export type MemoryFallback = typeof MemoryFallback.Type;

/**
 * Which model a memory task uses: the `same` as the others, the provider's `stronger` one, or, for
 * summaries only, `none` for summaries written with no AI.
 */
export const MemoryTaskModel = Schema.Literals(["same", "stronger"]);
export type MemoryTaskModel = typeof MemoryTaskModel.Type;

export const MemorySummaryModel = Schema.Literals(["same", "stronger", "none"]);
export type MemorySummaryModel = typeof MemorySummaryModel.Type;

/** The memory tasks that can be given their own model. Searching and saving never need one. */
export const MemoryTasks = Schema.Struct({
  /** Summing up a chat after it ends. */
  summaries: MemorySummaryModel,
  /** Check now: pages that disagree or look out of date. */
  check: MemoryTaskModel,
  /** Answering questions about memory in plain words. */
  answers: MemoryTaskModel,
});
export type MemoryTasks = typeof MemoryTasks.Type;

export type MemoryTask = keyof MemoryTasks;

/** Whether `model` is one Settings offers for `provider`. */
export const memoryModelOffered = (provider: MemoryModelProvider, model: MemoryModelName): boolean =>
  provider !== "none" && (MEMORY_MODELS[provider] as ReadonlyArray<string>).includes(model);

/**
 * The memory model as you chose it. With No AI the model, effort and fallback are kept as they
 * were, so turning AI back on picks up where you left it. The model is one its provider offers.
 */
export const MemorySettings = Schema.Struct({
  provider: MemoryModelProvider,
  model: MemoryModelName,
  effort: MemoryEffort,
  fallback: MemoryFallback,
  tasks: MemoryTasks,
}).check(
  Schema.makeFilter((settings) =>
    settings.provider === "none" || memoryModelOffered(settings.provider, settings.model)
      ? undefined
      : `${settings.model} is not a ${settings.provider} model`,
  ),
);
export type MemorySettings = typeof MemorySettings.Type;

/**
 * The choice before you make one (ADR 028): a small model at low effort, since thinking-mode models
 * can time out on summaries, and plain summaries when it is not available.
 */
export const DEFAULT_MEMORY_SETTINGS: MemorySettings = {
  provider: "claude",
  model: "haiku",
  effort: "low",
  fallback: "plain",
  tasks: { summaries: "same", check: "same", answers: "same" },
};

/** The other provider, which `other` falls back to. */
export const otherMemoryProvider = (provider: MemoryModelVendor): MemoryModelVendor =>
  provider === "claude" ? "chatgpt" : "claude";

/**
 * What memory runs with now, beside what you chose: `model` when the chosen model runs, `noAi` when
 * you chose No AI, and `needsKey` when Hobbots cannot hand the chosen provider a key yet, so memory
 * runs with no AI until it can.
 */
export const MemoryModelState = Schema.Union([
  Schema.TaggedStruct("Model", {}),
  Schema.TaggedStruct("NoAi", {}),
  Schema.TaggedStruct("NeedsKey", { provider: Schema.Literals(["claude", "chatgpt"]) }),
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
