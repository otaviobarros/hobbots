import {
  MEMORY_RUNTIMES,
  type MemoryModelVendor,
  type MemorySettings,
  NO_MEMORY_MODEL,
  otherMemoryProvider,
  SAME_MEMORY_MODEL,
} from "@hobbots/domain";
import { type EngineModel, type EngineSettings, type EngineTask, NO_MODEL, SMALLEST_MODEL } from "./config.ts";

/** A model on the provider's runtime: the one chosen, or its smallest when none is. */
const onRuntime = (provider: MemoryModelVendor, model: string | null): EngineModel => ({
  runtime: MEMORY_RUNTIMES[provider],
  name: model ?? SMALLEST_MODEL,
});

/** A task's own model, or none when it uses the memory model itself. */
const taskModel = (provider: MemoryModelVendor, choice: string): EngineModel | undefined =>
  choice === SAME_MEMORY_MODEL || choice === NO_MEMORY_MODEL ? undefined : onRuntime(provider, choice);

/**
 * The engine settings for the memory model you chose (ADR 028). Every model runs on its provider's
 * runtime through the hub's endpoint, which checks the model against what the runtime offers when
 * a task asks for it, so these depend on nothing but your choice: a runtime that is signed out or
 * limited fails the task, and the fallback applies. No AI leaves out every model, so no task calls
 * one.
 */
export const engineSettingsFor = (settings: MemorySettings): EngineSettings => {
  const provider = settings.provider;
  if (provider === "none") return NO_MODEL;
  const fallbacks = settings.fallback === "other" ? [onRuntime(otherMemoryProvider(provider), null)] : [];
  const own: ReadonlyArray<readonly [EngineTask, EngineModel | undefined]> = [
    ["consolidation", taskModel(provider, settings.tasks.summaries)],
    ["lint", taskModel(provider, settings.tasks.check)],
    ["query_answer", taskModel(provider, settings.tasks.answers)],
  ];
  return {
    model: onRuntime(provider, settings.model),
    effort: settings.effort,
    fallbacks,
    tasks: Object.fromEntries(own.filter(([, model]) => model !== undefined)),
    summarize: settings.tasks.summaries !== NO_MEMORY_MODEL,
  };
};
