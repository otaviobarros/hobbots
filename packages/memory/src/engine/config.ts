import { Redacted } from "effect";
import type { MemoryKeys } from "./keys.ts";

/** The name the engine writes as the author of your own edits (ADR 028): `[auth].root_username`. */
export const ROOT_USERNAME = "you";

/** A model as the engine names it: its provider's wire name and the model's id. */
export interface EngineModel {
  readonly provider: string;
  readonly name: string;
  /**
   * The environment variable holding the provider's key, for a provider that takes one. A fallback
   * must name it; the engine never lends it the main model's key.
   */
  readonly keyEnv?: string | undefined;
}

/** The engine's tasks that Hobbots gives their own model: `[llm.<task>]` in its config. */
export type EngineTask = "consolidation" | "lint" | "query_answer";

/**
 * The engine settings Hobbots chooses (ADR 028), from the memory model chosen in Settings › Your
 * data › Memory (`engineSettingsFor`). With no model, as with No AI, the engine makes no model call.
 */
export interface EngineSettings {
  readonly model: EngineModel | null;
  /** `llm_reasoning_effort`, shared by every task. */
  readonly effort?: string | undefined;
  /** Tried in order after the model fails transiently. */
  readonly fallbacks?: ReadonlyArray<EngineModel> | undefined;
  /** Tasks with their own model; each keeps `fallbacks` as its own chain. */
  readonly tasks?: Readonly<Partial<Record<EngineTask, EngineModel>>> | undefined;
  /** Whether a finished chat's summary is written with the model as well as without it. */
  readonly summarize?: boolean | undefined;
}

export const NO_MODEL: EngineSettings = { model: null };

/** A value the config may hold: a short plain token, never a quote or a newline. */
const SAFE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/;

const quoted = (value: string) => {
  if (!SAFE.test(value))
    throw new Error(`Refused an engine setting that is not a plain name: ${JSON.stringify(value)}`);
  return `"${value}"`;
};

const modelLines = (model: EngineModel) => [`provider = ${quoted(model.provider)}`, `model = ${quoted(model.name)}`];

const fallbackTables = (table: string, fallbacks: ReadonlyArray<EngineModel>) =>
  fallbacks.flatMap((fallback) => [
    "",
    `[[${table}]]`,
    ...modelLines(fallback),
    ...(fallback.keyEnv === undefined ? [] : [`api_key_env = ${quoted(fallback.keyEnv)}`]),
  ]);

const TASKS: ReadonlyArray<EngineTask> = ["consolidation", "lint", "query_answer"];

/**
 * The model's part of the config: none at all without a model, so no task can call one. A task
 * with its own model replaces the shared chain, so it repeats the fallbacks. The engine's learning
 * scheduler, which rewrites pages on its own, stays off: that is the Curator's, later (ADR 028).
 */
const modelConfig = (settings: EngineSettings) => {
  const model = settings.model;
  if (model === null) return { top: [], tables: [] };
  const fallbacks = settings.fallbacks ?? [];
  const top = [
    `llm_provider = ${quoted(model.provider)}`,
    `llm_model = ${quoted(model.name)}`,
    ...(settings.effort === undefined ? [] : [`llm_reasoning_effort = ${quoted(settings.effort)}`]),
    `consolidate_on_session_end = ${settings.summarize === false ? "false" : "true"}`,
  ];
  const tables = [
    ...fallbackTables("llm_fallbacks", fallbacks),
    ...TASKS.flatMap((task) => {
      const own = settings.tasks?.[task];
      return own === undefined
        ? []
        : ["", `[llm.${task}]`, ...modelLines(own), ...fallbackTables(`llm.${task}.fallbacks`, fallbacks)];
    }),
    "",
    "[auto_improve.scheduler]",
    "enabled = false",
  ];
  return { top, tables };
};

/**
 * The engine's config file, written by the hub before every start. It holds no credential: the
 * bearers reach the engine only in its environment (`AI_MEMORY_AUTH_TOKEN` and
 * `AI_MEMORY_AUTH__ACTOR_PROXY_BEARER_TOKEN`). The address is given on the command line.
 */
export const renderEngineConfig = (settings: EngineSettings): string => {
  const model = modelConfig(settings);
  return [
    "# Written by Hobbots before each start of its memory engine; edits here are replaced.",
    "# Credentials are never kept here: Hobbots passes them in the engine's environment.",
    'log_level = "info"',
    // Loopback only, and only the address Hobbots calls it by.
    'allowed_hosts = ["127.0.0.1"]',
    // Full-text, entity and link search: no embedding model is downloaded or called.
    'embedding_provider = "none"',
    ...model.top,
    ...model.tables,
    "",
    "[auth]",
    `root_username = ${quoted(ROOT_USERNAME)}`,
    "",
  ].join("\n");
};

/** Settings a config file must never hold, whatever their value (ADR 028). */
const CREDENTIAL_KEYS =
  /^\s*(bearer_token|bearer_token_file|actor_proxy_bearer_token|recovery_token|initial_root_password|token_pepper)\s*=/m;

/**
 * Whether a config file holds a credential: a credential setting, or either of the hub's bearers
 * anywhere in its text. The hub refuses to start the engine with such a file, and a backup refuses
 * to include one.
 */
export const configHoldsCredential = (config: string, keys: MemoryKeys): boolean =>
  CREDENTIAL_KEYS.test(config) ||
  config.includes(Redacted.value(keys.root)) ||
  config.includes(Redacted.value(keys.proxy));
