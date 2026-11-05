import type { RuntimeHealth, RuntimeKind } from "@hobbots/domain";
import { messages } from "../components/messages.ts";

/** Every provider a hob can think with, in the order the pickers list them. */
export const PROVIDERS: ReadonlyArray<RuntimeKind> = ["claude-code", "codex"];

/** The provider's name as the pickers and the hob's summary say it. */
export const PROVIDER_NAMES: Readonly<Record<RuntimeKind, string>> = messages.providers.names;

/** Who makes the provider and what runs it on this computer, under its name in onboarding. */
export const PROVIDER_MAKERS: Readonly<Record<RuntimeKind, string>> = messages.providers.makers;

/** The provider's square mark and its tile color, as a Tailwind class. */
export const PROVIDER_MARKS: Readonly<Record<RuntimeKind, { readonly mark: string; readonly tile: string }>> = {
  "claude-code": { mark: "C", tile: "bg-provider-claude" },
  codex: { mark: "G", tile: "bg-provider-codex" },
};

/** A runtime's state in a few words, as the brain picker and Settings › Memory say it. */
export const RUNTIME_STATE_WORDS: Readonly<Record<RuntimeHealth["availability"], string>> = {
  ready: "ready",
  outdated: "outdated",
  signedOut: "signed out",
  unavailable: "unavailable",
  unverified: "unverified",
};

/** The providers ready to think now, in the order the pickers list them. */
export const readyProviders = (
  runtimes: ReadonlyArray<RuntimeHealth> | undefined,
  only?: ReadonlyArray<RuntimeKind>,
): ReadonlyArray<RuntimeKind> =>
  PROVIDERS.filter(
    (runtime) =>
      (only?.includes(runtime) ?? true) &&
      runtimes?.some((health) => health.runtime === runtime && health.availability === "ready"),
  );
