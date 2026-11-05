import type { RuntimeKind } from "@hobbots/domain";
import { Redacted } from "effect";
import type { MemoryKeys } from "./keys.ts";

/** The name the engine writes as the author of your own edits (ADR 028): `[auth].root_username`. */
export const ROOT_USERNAME = "you";

/**
 * A model as Hobbots names it to the engine: the runtime that runs it and the model's id there, or
 * {@link SMALLEST_MODEL}. The engine reaches every model through the hub's memory model endpoint
 * (ADR 028), never through a provider of its own.
 */
export interface EngineModel {
  readonly runtime: RuntimeKind;
  readonly name: string;
}

/** The name a model the engine asks for has when it is the runtime's smallest, as the endpoint reads it. */
export const SMALLEST_MODEL = "smallest";

/**
 * The variable the engine finds the model bearer in: the one its OpenAI-compatible provider reads
 * for the main model, and the one Hobbots names for every fallback and task.
 */
export const MODEL_KEY_ENV = "LLM_API_KEY";

/** The engine's tasks that Hobbots gives their own model: `[llm.<task>]` in its config. */
export type EngineTask = "consolidation" | "lint" | "query_answer";

/**
 * The engine settings Hobbots chooses (ADR 028), from the memory model chosen in Settings › Your
 * data › Memory (`engineSettingsFor`). With no model, as with No AI, the engine makes no model call.
 */
export interface EngineSettings {
  readonly model: EngineModel | null;
  /** `llm_reasoning_effort`, shared by every task; the endpoint fits it to each model. */
  readonly effort?: string | undefined;
  /** Tried in order after the model fails transiently, as a plan's limit does. */
  readonly fallbacks?: ReadonlyArray<EngineModel> | undefined;
  /** Tasks with their own model; each keeps `fallbacks` as its own chain. */
  readonly tasks?: Readonly<Partial<Record<EngineTask, EngineModel>>> | undefined;
  /** Whether a finished chat's summary is written with the model as well as without it. */
  readonly summarize?: boolean | undefined;
}

export const NO_MODEL: EngineSettings = { model: null };

/** A value the config may hold: a short plain token, never a quote, space or newline. */
const SAFE = /^[A-Za-z0-9][A-Za-z0-9._:/@[\]-]{0,127}$/;

const quoted = (value: string) => {
  if (!SAFE.test(value))
    throw new Error(`Refused an engine setting that is not a plain name: ${JSON.stringify(value)}`);
  return `"${value}"`;
};

/** Where the engine reaches `runtime`'s models: the endpoint's path for it, in OpenAI's shape. */
export const modelBaseUrl = (endpoint: string, runtime: RuntimeKind) => `${endpoint}/${runtime}/v1`;

/** A model's table lines: the endpoint's OpenAI-compatible provider, and the bearer's variable. */
const modelLines = (model: EngineModel, endpoint: string) => [
  'provider = "openai-compat"',
  `model = ${quoted(model.name)}`,
  `base_url = ${quoted(modelBaseUrl(endpoint, model.runtime))}`,
  `api_key_env = ${quoted(MODEL_KEY_ENV)}`,
];

const fallbackTables = (table: string, fallbacks: ReadonlyArray<EngineModel>, endpoint: string) =>
  fallbacks.flatMap((fallback) => ["", `[[${table}]]`, ...modelLines(fallback, endpoint)]);

const TASKS: ReadonlyArray<EngineTask> = ["consolidation", "lint", "query_answer"];

/**
 * The model's part of the config: none at all without a model or an endpoint, so no task can call
 * one. A task with its own model replaces the shared chain, so it repeats the fallbacks. The schema
 * of a structured answer goes in the prompt (`llm_compat_strict = false`), since a runtime takes no
 * `response_format`. The engine's learning scheduler, which rewrites pages on its own, stays off:
 * that is the Curator's, later (ADR 028).
 */
const modelConfig = (settings: EngineSettings, endpoint: string | null) => {
  const model = settings.model;
  if (model === null || endpoint === null) return { top: [], tables: [] };
  const fallbacks = settings.fallbacks ?? [];
  const top = [
    'llm_provider = "openai-compat"',
    `llm_model = ${quoted(model.name)}`,
    `llm_base_url = ${quoted(modelBaseUrl(endpoint, model.runtime))}`,
    "llm_compat_strict = false",
    ...(settings.effort === undefined ? [] : [`llm_reasoning_effort = ${quoted(settings.effort)}`]),
    `consolidate_on_session_end = ${settings.summarize === false ? "false" : "true"}`,
  ];
  const tables = [
    ...fallbackTables("llm_fallbacks", fallbacks, endpoint),
    ...TASKS.flatMap((task) => {
      const own = settings.tasks?.[task];
      return own === undefined
        ? []
        : [
            "",
            `[llm.${task}]`,
            ...modelLines(own, endpoint),
            ...fallbackTables(`llm.${task}.fallbacks`, fallbacks, endpoint),
          ];
    }),
    "",
    "[auto_improve.scheduler]",
    "enabled = false",
  ];
  return { top, tables };
};

/**
 * The engine's config file, written by the hub before every start. It holds no credential: the
 * bearers reach the engine only in its environment (`AI_MEMORY_AUTH_TOKEN`,
 * `AI_MEMORY_AUTH__ACTOR_PROXY_BEARER_TOKEN` and {@link MODEL_KEY_ENV}). Its own address is given on
 * the command line; `endpoint` is the hub's memory model endpoint, or null when there is none.
 */
export const renderEngineConfig = (settings: EngineSettings, endpoint: string | null): string => {
  const model = modelConfig(settings, endpoint);
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
  /^\s*(bearer_token|bearer_token_file|actor_proxy_bearer_token|recovery_token|initial_root_password|token_pepper|llm_api_key|api_key)\s*=/m;

/**
 * Whether a config file holds a credential: a credential setting, whatever its value, or, with the
 * hub's keys, any of its bearers anywhere in its text. The hub refuses to start the engine with such
 * a file, and a backup refuses to include one.
 */
export const configHoldsCredential = (config: string, keys?: MemoryKeys): boolean =>
  CREDENTIAL_KEYS.test(config) ||
  (keys !== undefined && [keys.root, keys.proxy, keys.model].some((key) => config.includes(Redacted.value(key))));
