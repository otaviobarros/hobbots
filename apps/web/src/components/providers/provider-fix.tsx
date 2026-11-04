import type { RuntimeHealth, RuntimeKind } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { cn } from "@hobbots/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { Fragment } from "react";
import { runtimesQuery } from "../../api/queries.ts";
import { claudeInstallGuide, codexInstallGuide, runtimeProblem, signInProblem } from "../../api/runtime-health.ts";
import { messages } from "../settings/messages.ts";

const copy = messages.providers;

/** A sentence from the messages with its `{command}` shown as code. */
export function WithCommand({ text, command }: { text: string; command: string }) {
  const parts = text.split("{command}");
  return (
    <>
      {parts.map((part, index) => (
        // The parts of one fixed sentence never move, so their position is their identity.
        // biome-ignore lint/suspicious/noArrayIndexKey: see above
        <Fragment key={index}>
          {index > 0 && <code>{command}</code>}
          {part}
        </Fragment>
      ))}
    </>
  );
}

/**
 * What is wrong with the provider and how to fix it, in its own words; null when nothing is.
 * Settings, onboarding and the brain pickers say it the same way.
 */
export const providerFix = (runtime: RuntimeKind, health: RuntimeHealth | undefined) => {
  const words = copy[runtime];
  switch (signInProblem(health) ?? runtimeProblem(health)) {
    case "outdated":
      return <WithCommand text={words.outdated} command={words.updateCommand} />;
    case "notFound":
      return <WithCommand text={words.notFound} command={words.signInCommand} />;
    case "signedOut":
      return <WithCommand text={words.signedOut} command={words.signInCommand} />;
    case "notStarted":
      return <WithCommand text={words.notStarted} command={words.startCommand} />;
    case "apiKey":
      return <WithCommand text={copy.codex.apiKey} command={copy.codex.signInCommand} />;
    case "otherProvider":
      return <WithCommand text={copy.codex.otherProvider} command={copy.codex.signInCommand} />;
    default:
      return null;
  }
};

const GUIDES: Readonly<Record<RuntimeKind, string>> = { "claude-code": claudeInstallGuide, codex: codexInstallGuide };

/**
 * What the user can do once they fixed the provider: install it from its guide when it is missing,
 * and check again, which needs no restart.
 */
export function ProviderFixActions({
  runtime,
  notFound,
  size = "sm",
  className,
}: {
  runtime: RuntimeKind;
  notFound: boolean;
  size?: "sm" | "xs";
  className?: string | undefined;
}) {
  const runtimes = useQuery(runtimesQuery);
  return (
    <div className={cn("mt-2 flex flex-wrap items-center gap-2", className)}>
      {notFound && (
        <Button asChild variant="outline" size={size}>
          <a href={GUIDES[runtime]} target="_blank" rel="noreferrer">
            {copy.installGuide}
          </a>
        </Button>
      )}
      <Button
        type="button"
        variant="outline"
        size={size}
        onClick={() => void runtimes.refetch()}
        disabled={runtimes.isFetching}
      >
        {runtimes.isFetching ? copy.lookingAgain : copy.checkAgain}
      </Button>
      <span className="text-xs text-label">{copy.noRestart}</span>
    </div>
  );
}
