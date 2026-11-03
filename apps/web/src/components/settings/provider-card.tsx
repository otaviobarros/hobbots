import { RUNTIME_NAMES, type RuntimeHealth, type RuntimeKind } from "@hobbots/domain";
import { Badge } from "@hobbots/ui/components/badge";
import { Button } from "@hobbots/ui/components/button";
import { useQuery } from "@tanstack/react-query";
import { Fragment } from "react";
import { runtimesQuery } from "../../api/queries.ts";
import { claudeInstallGuide, codexInstallGuide, runtimeProblem, signInProblem } from "../../api/runtime-health.ts";
import { EnforcementList } from "../enforcement.tsx";
import { messages as sharedMessages } from "../messages.ts";
import { messages } from "./messages.ts";

const copy = messages.providers;

const PROVIDER_LOOK: Record<RuntimeKind, { readonly mark: string; readonly tile: string; readonly guide: string }> = {
  "claude-code": { mark: "C", tile: "bg-[#e39a74]", guide: claudeInstallGuide },
  codex: { mark: "G", tile: "bg-[#8fd3a8]", guide: codexInstallGuide },
};

/** A sentence from the messages with its `{command}` shown as code. */
function WithCommand({ text, command }: { text: string; command: string }) {
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

/** What is wrong with the provider and how to fix it, in its own words; null when nothing is. */
const fixHint = (runtime: RuntimeKind, health: RuntimeHealth | undefined) => {
  const words = copy[runtime];
  const signIn = signInProblem(health);
  switch (signIn ?? runtimeProblem(health)) {
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

/** Claude Code that bills an API key instead of the user's subscription, which costs them extra. */
const billsElsewhere = (health: RuntimeHealth | undefined) =>
  health?.runtime === "claude-code" &&
  health.availability === "ready" &&
  !(health.billing?.startsWith("subscription") ?? false) &&
  health.billing !== "fake";

function ProviderFacts({ health }: { health: RuntimeHealth }) {
  return (
    <>
      <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        <dt className="text-label">{copy.billing}</dt>
        <dd className={billsElsewhere(health) ? "m-0 text-lantern" : "m-0"}>{health.billing ?? "—"}</dd>
        <dt className="text-label">{copy.version}</dt>
        <dd className="m-0">{health.version ?? "—"}</dd>
      </dl>
      <h3 className="lbl mt-3 mb-1.5 text-xs text-label">{sharedMessages.enforcement.providerHeading}</h3>
      <EnforcementList enforcement={health.enforcement} />
    </>
  );
}

function FixActions({ guide, notFound }: { guide: string; notFound: boolean }) {
  const runtimes = useQuery(runtimesQuery);
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      {notFound && (
        <Button asChild variant="outline" size="sm">
          <a href={guide} target="_blank" rel="noreferrer">
            {copy.installGuide}
          </a>
        </Button>
      )}
      <Button variant="outline" size="sm" onClick={() => void runtimes.refetch()} disabled={runtimes.isFetching}>
        {runtimes.isFetching ? copy.lookingAgain : copy.checkAgain}
      </Button>
      <span className="text-xs text-label">{copy.noRestart}</span>
    </div>
  );
}

/**
 * One provider's health in Settings › AI providers, with how to fix it when it cannot think.
 * Detail is never shown: it can carry account names.
 */
export function ProviderCard({ runtime }: { runtime: RuntimeKind }) {
  const runtimes = useQuery(runtimesQuery);
  const health = runtimes.data?.find((entry) => entry.runtime === runtime);
  const name = RUNTIME_NAMES[runtime];
  const look = PROVIDER_LOOK[runtime];
  const hint = fixHint(runtime, health);
  const availability = health?.availability ?? "unavailable";

  return (
    <section aria-label={name} className="cut bg-card p-3">
      <div className="mb-2 flex items-center gap-2">
        <span aria-hidden className={`grid size-5 place-items-center text-xs font-bold text-ground ${look.tile}`}>
          {look.mark}
        </span>
        <span className="font-pixel flex-1 text-base font-semibold">{name}</span>
        <Badge variant={availability === "ready" ? "working" : "waiting"}>
          {runtimes.isPending ? copy.checking : copy.availability[availability]}
        </Badge>
      </div>
      {health && <ProviderFacts health={health} />}
      {hint && <p className="mt-2 mb-0 text-sm text-lantern">{hint}</p>}
      {hint && <FixActions guide={look.guide} notFound={health?.version === null} />}
      {billsElsewhere(health) && <p className="mt-2 mb-0 text-sm text-lantern">{copy["claude-code"].billingWarning}</p>}
    </section>
  );
}
