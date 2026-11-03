import type { RuntimeHealth, RuntimeKind } from "@hobbots/domain";

export const claudeInstallGuide = "https://code.claude.com/docs/en/setup";

/** Where OpenAI explains installing Codex and signing in. */
export const codexInstallGuide = "https://developers.openai.com/codex/cli";

/**
 * Why a signed-out Codex cannot run hobs: no sign-in, or one that is not a ChatGPT plan, which the
 * hub reports as its billing (ADR 024). Null for any other state.
 */
export const signInProblem = (health: RuntimeHealth | undefined): "signedOut" | "apiKey" | "otherProvider" | null => {
  if (health?.availability !== "signedOut") return null;
  if (health.runtime !== "codex" || health.billing === null) return "signedOut";
  return health.billing === "api-key" ? "apiKey" : "otherProvider";
};

/** What the user has to fix before the provider can run, or null when nothing is wrong. */
export const runtimeProblem = (
  health: RuntimeHealth | undefined,
): "notFound" | "notStarted" | "outdated" | "signedOut" | null => {
  if (health === undefined) return null;
  switch (health.availability) {
    case "outdated":
      return "outdated";
    case "signedOut":
      return "signedOut";
    case "unavailable":
      return health.version === null ? "notFound" : "notStarted";
    default:
      return null;
  }
};

/**
 * Setup continues once the user has connected at least one provider that is ready to think for
 * the first hob. A ready provider the user has not connected does not count.
 */
export const canContinueSetup = (
  runtimes: ReadonlyArray<RuntimeHealth> | undefined,
  connected: ReadonlyArray<RuntimeKind> | undefined,
): boolean =>
  runtimes?.some((health) => health.availability === "ready" && (connected?.includes(health.runtime) ?? false)) ??
  false;

/**
 * Providers are checked at most once a minute. While one needs fixing, coming back to the window
 * checks again at once, as after installing or updating Claude Code in a terminal.
 */
export const runtimeRefetchOnFocus = (runtimes: ReadonlyArray<RuntimeHealth> | undefined): boolean | "always" =>
  runtimes?.every((health) => health.availability === "ready") ? true : "always";
