import { RUNTIME_NAMES, type RuntimeHealth, type RuntimeKind } from "@hobbots/domain";
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
 * A signed-out provider's fix as three plain steps: open Terminal, type its sign-in command, sign
 * in and come back. Setup shows it where a sentence would ask too much at once.
 */
export function SignInSteps({ runtime }: { runtime: RuntimeKind }) {
  const steps = copy.signInSteps;
  return (
    <div className="flex flex-col gap-1.5 [&_code]:rounded-tag [&_code]:bg-deep [&_code]:px-1.5 [&_code]:font-mono [&_code]:text-text-strong">
      <span>{steps.intro({ provider: RUNTIME_NAMES[runtime] })}</span>
      <ol className="m-0 flex flex-col gap-1 ps-5">
        <li>{steps.open}</li>
        <li>
          <WithCommand text={steps.type} command={copy[runtime].signInCommand} />
        </li>
        <li>{steps.signIn}</li>
      </ol>
    </div>
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
      <span className="text-meta text-label">{copy.noRestart}</span>
    </div>
  );
}
