import type { RuntimeHealth, RuntimeKind } from "@hobbots/domain";
import { messages } from "../components/messages.ts";
import { formatList } from "./format.ts";

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

/**
 * The providers the user connected in onboarding, in the order the pickers list them, as the
 * steps after it sum them up, such as "Claude and Codex connected". Null before any is connected.
 */
const connectedLine = (connected: ReadonlyArray<RuntimeKind> | undefined): string | null => {
  const names = PROVIDERS.filter((runtime) => connected?.includes(runtime)).map((runtime) => PROVIDER_NAMES[runtime]);
  return names.length === 0 ? null : messages.providers.connected({ names: formatList(names) });
};

/** The connected providers' line, as a list of at most one line for the steps' summary. */
export const connectedLines = (connected: ReadonlyArray<RuntimeKind> | undefined): ReadonlyArray<string> => {
  const line = connectedLine(connected);
  return line === null ? [] : [line];
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
