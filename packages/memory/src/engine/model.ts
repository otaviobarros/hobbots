import {
  type MemoryModelName,
  type MemoryModelState,
  type MemoryModelVendor,
  type MemorySettings,
  otherMemoryProvider,
  STRONGER_MEMORY_MODEL,
} from "@hobbots/domain";
import { type EngineModel, type EngineSettings, type EngineTask, NO_MODEL } from "./config.ts";

/** Each provider as the engine names it, and how it signs in. */
const ENGINE_PROVIDERS: Readonly<Record<MemoryModelVendor, string>> = {
  // An Anthropic API key. A Claude subscription's sign-in is refused for other apps.
  claude: "anthropic",
  // The ChatGPT sign-in, through Codex.
  chatgpt: "codex",
};

/** Each model's id at its provider. */
const ENGINE_MODELS: Readonly<Record<MemoryModelName, string>> = {
  haiku: "claude-haiku-5-5",
  sonnet: "claude-sonnet-5-5",
  opus: "claude-opus-5-5",
  mini: "gpt-5.4-mini",
  "gpt-5.5": "gpt-5.5",
};

/** The variable each provider's key is in; the ChatGPT sign-in has its own files instead. */
const KEY_ENV: Readonly<Record<MemoryModelVendor, string | undefined>> = {
  claude: "ANTHROPIC_API_KEY",
  chatgpt: undefined,
};

const engineModel = (provider: MemoryModelVendor, model: MemoryModelName): EngineModel => ({
  provider: ENGINE_PROVIDERS[provider],
  name: ENGINE_MODELS[model],
  keyEnv: KEY_ENV[provider],
});

/** The engine settings for a memory model, and what memory runs with because of them. */
export interface EngineChoice {
  readonly engine: EngineSettings;
  readonly state: MemoryModelState;
}

/**
 * The engine settings for the memory model you chose (ADR 028). The engine refuses to start with
 * a provider it has no credential for, so a provider `canRun` does not answer for is left out: the
 * engine runs with no AI when it is the chosen one, and plain summaries stand in for it as a
 * fallback. No AI leaves out every model, so no task calls one.
 */
export const engineSettingsFor = (
  settings: MemorySettings,
  canRun: (provider: MemoryModelVendor) => boolean,
): EngineChoice => {
  const provider = settings.provider;
  if (provider === "none") return { engine: NO_MODEL, state: { _tag: "NoAi" } };
  if (!canRun(provider)) return { engine: NO_MODEL, state: { _tag: "NeedsKey", provider } };
  const other = otherMemoryProvider(provider);
  const fallbacks = settings.fallback === "other" && canRun(other) ? [engineModel(other, otherSmallModel(other))] : [];
  const stronger = engineModel(provider, STRONGER_MEMORY_MODEL[provider]);
  const tasks: Partial<Record<EngineTask, EngineModel>> = {
    ...(settings.tasks.summaries === "stronger" && { consolidation: stronger }),
    ...(settings.tasks.check === "stronger" && { lint: stronger }),
    ...(settings.tasks.answers === "stronger" && { query_answer: stronger }),
  };
  return {
    engine: {
      model: engineModel(provider, settings.model),
      effort: settings.effort,
      fallbacks,
      tasks,
      summarize: settings.tasks.summaries !== "none",
    },
    state: { _tag: "Model" },
  };
};

/** The model a fallback to `provider` uses: its smallest. */
const otherSmallModel = (provider: MemoryModelVendor): MemoryModelName => (provider === "claude" ? "haiku" : "mini");
