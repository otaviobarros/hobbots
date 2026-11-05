import { Redacted } from "effect";
import type { MemoryKeys } from "./keys.ts";

/** The name the engine writes as the author of your own edits (ADR 028): `[auth].root_username`. */
export const ROOT_USERNAME = "you";

/**
 * The engine settings Hobbots chooses (ADR 028). The memory model is chosen in Settings › Your data ›
 * Memory; until then, and with No AI, the engine runs without a model.
 */
export interface EngineSettings {
  readonly model: { readonly provider: string; readonly name: string } | null;
}

export const NO_MODEL: EngineSettings = { model: null };

/** A value the config may hold: a short plain token, never a quote or a newline. */
const SAFE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/;

const quoted = (value: string) => {
  if (!SAFE.test(value))
    throw new Error(`Refused an engine setting that is not a plain name: ${JSON.stringify(value)}`);
  return `"${value}"`;
};

/**
 * The engine's config file, written by the hub before every start. It holds no credential: the
 * bearers reach the engine only in its environment (`AI_MEMORY_AUTH_TOKEN` and
 * `AI_MEMORY_AUTH__ACTOR_PROXY_BEARER_TOKEN`). The address is given on the command line.
 */
export const renderEngineConfig = (settings: EngineSettings): string =>
  [
    "# Written by Hobbots before each start of its memory engine; edits here are replaced.",
    "# Credentials are never kept here: Hobbots passes them in the engine's environment.",
    'log_level = "info"',
    // Loopback only, and only the address Hobbots calls it by.
    'allowed_hosts = ["127.0.0.1"]',
    // Full-text, entity and link search: no embedding model is downloaded or called.
    'embedding_provider = "none"',
    ...(settings.model === null
      ? []
      : [`llm_provider = ${quoted(settings.model.provider)}`, `llm_model = ${quoted(settings.model.name)}`]),
    "",
    "[auth]",
    `root_username = ${quoted(ROOT_USERNAME)}`,
    "",
  ].join("\n");

/** Settings a config file must never hold, whatever their value (ADR 028). */
const CREDENTIAL_KEYS =
  /^\s*(bearer_token|bearer_token_file|actor_proxy_bearer_token|recovery_token|initial_root_password|token_pepper)\s*=/m;

/**
 * Whether a config file holds a credential: a credential setting, whatever its value, or, with the
 * hub's keys, either of its bearers anywhere in its text. The hub refuses to start the engine with such a file, and a backup refuses
 * to include one.
 */
export const configHoldsCredential = (config: string, keys?: MemoryKeys): boolean =>
  CREDENTIAL_KEYS.test(config) ||
  (keys !== undefined && (config.includes(Redacted.value(keys.root)) || config.includes(Redacted.value(keys.proxy))));
