import type { RuntimeHealth, RuntimeKind } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { cn } from "@hobbots/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { useCanGoBack, useNavigate, useRouter } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { runtimesQuery } from "../api/queries.ts";
import { canContinueSetup, claudeInstallGuide, codexInstallGuide, runtimeProblem } from "../api/runtime-health.ts";
import { useUpdateSetup, watchedSetupQuery } from "../api/setup.ts";
import { connectedLines, PROVIDER_MAKERS, PROVIDER_MARKS, PROVIDER_NAMES, PROVIDERS } from "../lib/providers.ts";
import { messages } from "./messages.ts";
import { OnboardingFrame } from "./onboarding-frame.tsx";
import { providerFix, WithCommand } from "./provider-fix.tsx";

const shared = messages.onboarding;
const copy = messages.onboarding.providers;

const INSTALL_GUIDES: Readonly<Record<RuntimeKind, string>> = {
  "claude-code": claudeInstallGuide,
  codex: codexInstallGuide,
};

// Providers from the Hobbots design that arrive in a later slice.
const LATER = [
  { ...copy.later.gemini, mark: "G", tile: "bg-provider-gemini" },
  { ...copy.later.grok, mark: "X", tile: "bg-provider-grok" },
  { ...copy.later.local, mark: "L", tile: "bg-provider-local" },
  { ...copy.later.other, mark: "+", tile: "bg-provider-other" },
];

/** Found and connected are both a ready provider; only the user's Connect turns one into the other. */
type ProviderState =
  | "checking"
  | "found"
  | "connected"
  | "notFound"
  | "notStarted"
  | "outdated"
  | "signedOut"
  | "unknown";

const providerState = (
  pending: boolean,
  failed: boolean,
  health: RuntimeHealth | undefined,
  connected: boolean,
): ProviderState => {
  if (pending) return "checking";
  if (health?.availability === "ready") return connected ? "connected" : "found";
  return (failed ? null : runtimeProblem(health)) ?? "unknown";
};

const TAG: Record<ProviderState, { label: string; className: string } | null> = {
  checking: null,
  found: { label: copy.tags.found, className: "bg-moonlight text-ground" },
  connected: { label: copy.tags.connected, className: "bg-moonlight text-ground" },
  notFound: { label: copy.tags.notFound, className: "bg-line-2 text-text-strong" },
  notStarted: { label: copy.tags.notStarted, className: "bg-rose text-ground" },
  outdated: { label: copy.tags.outdated, className: "bg-rose text-ground" },
  signedOut: { label: copy.tags.signedOut, className: "bg-lantern text-ground" },
  unknown: { label: copy.tags.unknown, className: "bg-line-2 text-text-strong" },
};

const BORDER: Record<ProviderState, string> = {
  checking: "border-lantern",
  found: "border-control",
  connected: "border-mint",
  notFound: "border-line-2",
  notStarted: "border-rose",
  outdated: "border-rose",
  signedOut: "border-control",
  unknown: "border-line-2",
};

const claudeHow = (state: ProviderState, claude: RuntimeHealth | undefined): ReactNode => {
  const words = copy.claude;
  const version = claude?.version ?? null;
  switch (state) {
    case "checking":
      return words.checking;
    case "found":
    case "connected":
      return words.ready({ version });
    case "notFound":
      return words.notFound;
    case "notStarted":
      return <WithCommand text={words.notStarted} command={words.command} />;
    case "outdated":
      return words.outdated({ version });
    case "signedOut":
      return <WithCommand text={words.signedOut} command={words.command} />;
    case "unknown":
      return words.unknown;
  }
};

/** What a Codex card says, with the same fixes as Settings for each state that stops it. */
const codexHow = (state: ProviderState, codex: RuntimeHealth | undefined): ReactNode => {
  switch (state) {
    case "checking":
      return copy.codex.checking;
    case "found":
    case "connected":
      return copy.codex.ready({ version: codex?.version ?? null });
    case "unknown":
      return copy.codex.unknown;
    default:
      return providerFix("codex", codex);
  }
};

const how = (runtime: RuntimeKind, state: ProviderState, health: RuntimeHealth | undefined): ReactNode =>
  runtime === "codex" ? codexHow(state, health) : claudeHow(state, health);

function ProviderMark({ mark, tile }: { mark: string; tile: string }) {
  return (
    <span
      aria-hidden
      className={cn("cut grid size-9 flex-none place-items-center text-[19px] font-bold text-ground", tile)}
    >
      {mark}
    </span>
  );
}

/** The bottom of a provider card: what the provider's state is and what the user can do about it. */
function CardFooter({ children }: { children: ReactNode }) {
  return (
    <div className="mt-auto flex min-h-11 items-center justify-between gap-2.5 border-line border-t-2 pt-2.5">
      {children}
    </div>
  );
}

function Busy({ children }: { children: ReactNode }) {
  return (
    <span className="text-sm text-lantern">
      {children} <span className="animate-hb-blink">•••</span>
    </span>
  );
}

/** The plan a ready provider bills, in the user's words where Hobbots knows them. */
const planLine = (runtime: RuntimeKind, health: RuntimeHealth | undefined) => {
  const onSubscription = health?.billing?.startsWith("subscription") ?? false;
  if (!onSubscription) return health?.billing;
  return messages.providers.plan[runtime];
};

/** The card's footer for a provider that needs a fix: its install guide when missing, and Check again. */
function FixFooter({
  runtime,
  state,
  onCheckAgain,
}: {
  runtime: RuntimeKind;
  state: ProviderState;
  onCheckAgain: () => void;
}) {
  return (
    <>
      <span className="text-xs text-label">
        {state === "outdated" && runtime === "claude-code" ? (
          <WithCommand text={copy.claude.update} command={copy.claude.updateCommand} />
        ) : (
          copy.noRestart
        )}
      </span>
      <CardFooter>
        {state === "notFound" && (
          <Button asChild variant="outline" size="sm">
            <a href={INSTALL_GUIDES[runtime]} target="_blank" rel="noreferrer">
              {copy.installGuide}
            </a>
          </Button>
        )}
        <Button variant="outline" size="sm" className="ml-auto border-lantern" onClick={onCheckAgain}>
          {copy.checkAgain}
        </Button>
      </CardFooter>
    </>
  );
}

/** One provider card's state and what its buttons do. */
interface ProviderCardProps {
  runtime: RuntimeKind;
  state: ProviderState;
  health: RuntimeHealth | undefined;
  checking: boolean;
  saving: "connect" | "disconnect" | null;
  /** Another provider's Connect or Disconnect is on its way, so this card's waits for it. */
  locked: boolean;
  onCheckAgain: () => void;
  onConnect: () => void;
  onDisconnect: () => void;
}

/** What a provider card's footer shows: the wait, Connect, Connected with Disconnect, or the fix. */
function ProviderFooter({
  runtime,
  state,
  health,
  checking,
  saving,
  locked,
  onCheckAgain,
  onConnect,
  onDisconnect,
}: ProviderCardProps) {
  const name = PROVIDER_NAMES[runtime];
  const ready = state === "found" || state === "connected";
  if (saving) {
    return (
      <CardFooter>
        <Busy>{saving === "connect" ? copy.connecting : copy.disconnecting}</Busy>
      </CardFooter>
    );
  }
  if (state === "checking" || (checking && !ready)) {
    return (
      <CardFooter>
        <Busy>{copy.looking}</Busy>
      </CardFooter>
    );
  }
  if (state === "found") {
    return (
      <CardFooter>
        <span className="text-[13px] text-label">{copy.notConnected}</span>
        <Button
          variant="outline"
          size="sm"
          className="flex-none"
          aria-label={copy.connectLabel({ provider: name })}
          disabled={locked}
          onClick={onConnect}
        >
          {copy.connect}
        </Button>
      </CardFooter>
    );
  }
  if (state === "connected") {
    const plan = planLine(runtime, health);
    return (
      <CardFooter>
        <span className="flex min-w-0 flex-col leading-tight">
          <span className="animate-hb-pop truncate text-sm font-bold text-mint">{copy.connected}</span>
          {plan && <span className="truncate text-[13px] text-text-secondary">{plan}</span>}
        </span>
        <Button
          variant="outline"
          size="sm"
          className="flex-none"
          aria-label={copy.disconnectLabel({ provider: name })}
          disabled={locked}
          onClick={onDisconnect}
        >
          {copy.disconnect}
        </Button>
      </CardFooter>
    );
  }
  return <FixFooter runtime={runtime} state={state} onCheckAgain={onCheckAgain} />;
}

/** One provider found, or not, on this computer: its state, what it means and what to do. */
function ProviderCard(props: ProviderCardProps) {
  const { runtime, state, health, saving } = props;
  const tag = TAG[state];
  const look = PROVIDER_MARKS[runtime];
  const headingId = `provider-${runtime}`;
  return (
    <section
      aria-labelledby={headingId}
      className={`cut flex flex-col gap-2.5 border-2 bg-card p-3.5 ${saving ? "border-lantern" : BORDER[state]}`}
    >
      <div className="flex items-center gap-2.5">
        <ProviderMark mark={look.mark} tile={look.tile} />
        <div className="flex min-w-0 flex-1 flex-col">
          <h2 id={headingId} className="m-0 text-base font-bold">
            {PROVIDER_NAMES[runtime]}
          </h2>
          <span className="text-[13px] text-text-secondary">{PROVIDER_MAKERS[runtime]}</span>
        </div>
        {tag && <span className={`px-[7px] py-0.5 text-xs font-bold ${tag.className}`}>{tag.label}</span>}
      </div>
      <span className="min-h-9 text-[13px] leading-snug text-text-secondary">{how(runtime, state, health)}</span>
      <ProviderFooter {...props} />
    </section>
  );
}

/** What the Elder Hob says: found, connected, a nudge to connect one, or that each needs a fix. */
const guideFor = (
  ready: boolean,
  nudged: boolean,
  states: ReadonlyArray<readonly [RuntimeKind, ProviderState]>,
): string => {
  if (ready) return copy.guide.connected;
  if (nudged) return copy.guide.nudge;
  if (states.some(([, state]) => state === "checking")) return copy.guide.looking;
  const found = states.find(([, state]) => state === "found");
  return found ? copy.guide.found({ provider: PROVIDER_NAMES[found[0]] }) : copy.guide.fix;
};

/**
 * Onboarding step 1: the providers found on this computer, Claude Code and Codex. A ready provider
 * shows as found until the user connects it; the choice is stored on the hub, and setup continues
 * once any connected provider is ready. Each problem shows its fix and Check again, so fixing it in
 * a terminal is enough, without restarting Hobbots.
 */
export function OnboardingProviders() {
  const navigate = useNavigate();
  const router = useRouter();
  const canGoBack = useCanGoBack();
  const providers = useUpdateSetup();
  const runtimes = useQuery(runtimesQuery);
  // Another window or device may connect or disconnect a provider while this step is open.
  const setup = useQuery(watchedSetupQuery);
  const connected = setup.data?.connectedProviders ?? [];
  const pending = runtimes.isPending || setup.isPending;
  const healthOf = (runtime: RuntimeKind) => runtimes.data?.find((health) => health.runtime === runtime);
  const states = PROVIDERS.map(
    (runtime) =>
      [runtime, providerState(pending, runtimes.isError, healthOf(runtime), connected.includes(runtime))] as const,
  );
  const ready = canContinueSetup(runtimes.data, connected);
  const readyConnected = states.filter(([, state]) => state === "connected").map(([runtime]) => runtime);
  const [nudged, setNudged] = useState(false);
  // The provider whose Connect or Disconnect is on its way.
  const [changing, setChanging] = useState<RuntimeKind | null>(null);

  // Each change sends the whole list, so one waits for the other: a second click mid-request would
  // otherwise send a list without the first provider and undo it.
  const change = (runtime: RuntimeKind, connect: boolean) => {
    if (providers.isPending) return;
    if (connect) setNudged(false);
    setChanging(runtime);
    const others = connected.filter((kind) => kind !== runtime);
    providers.mutate({ connectedProviders: connect ? [...others, runtime] : others });
  };
  const savingFor = (runtime: RuntimeKind) =>
    providers.isPending && changing === runtime
      ? providers.variables.connectedProviders?.includes(runtime)
        ? "connect"
        : "disconnect"
      : null;

  const guide = guideFor(ready, nudged, states);

  const back = () => (canGoBack ? router.history.back() : void navigate({ to: "/setup/remote" }));
  const next = () => {
    if (!ready) return setNudged(true);
    void navigate({ to: "/setup/hob" });
  };

  const failed = providers.isError;
  const count = readyConnected.length;

  return (
    <OnboardingFrame
      step={0}
      guide={guide}
      sofar={connectedLines(readyConnected)}
      footer={
        <>
          <Button variant="outline" onClick={back}>
            {shared.back}
          </Button>
          <span
            id="providers-hint"
            role={failed ? "alert" : undefined}
            className={`flex-1 text-right text-sm ${failed ? "text-rose" : ready ? "text-text-secondary" : "text-lantern"}`}
          >
            {failed ? copy.saveFailed : ready ? messages.providers.connectedCount({ count }) : copy.connectOne}
          </span>
          <Button
            onClick={next}
            aria-disabled={!ready}
            aria-describedby="providers-hint"
            disabled={providers.isPending}
            className={
              ready
                ? undefined
                : "cursor-not-allowed bg-line-2 text-label shadow-[0_4px_0_color-mix(in_srgb,var(--color-line-2)_60%,black)] hover:bg-line-2"
            }
          >
            {shared.continue}
          </Button>
        </>
      }
    >
      <div className="flex animate-hb-in flex-col gap-1.5">
        <h1 className="m-0 font-heading text-[30px] font-bold text-moonlight">{copy.heading}</h1>
        <p className="m-0 mb-3.5 text-text-secondary">{copy.intro}</p>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
          {states.map(([runtime, state]) => (
            <ProviderCard
              key={runtime}
              runtime={runtime}
              state={state}
              health={healthOf(runtime)}
              checking={runtimes.isFetching}
              saving={savingFor(runtime)}
              locked={providers.isPending}
              onCheckAgain={() => void runtimes.refetch()}
              onConnect={() => change(runtime, true)}
              onDisconnect={() => change(runtime, false)}
            />
          ))}
          {LATER.map((p) => (
            <section
              key={p.name}
              aria-label={copy.later.label({ provider: p.name })}
              className="cut flex flex-col gap-2.5 border-2 border-line-2 bg-card p-3.5"
            >
              <div className="flex items-center gap-2.5">
                <ProviderMark mark={p.mark} tile={p.tile} />
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="text-base font-bold">{p.name}</span>
                  <span className="text-[13px] text-text-secondary">{p.maker}</span>
                </div>
                <span className="bg-lantern px-[7px] py-0.5 text-xs font-bold text-ground">{copy.later.tag}</span>
              </div>
              <span className="min-h-9 text-[13px] leading-snug text-text-secondary">{p.how}</span>
              <CardFooter>
                <span className="text-[13px] text-label">{copy.later.arrives}</span>
              </CardFooter>
            </section>
          ))}
        </div>
        <p className="mt-3 mb-0 text-[13px] text-label">{copy.privacy}</p>
      </div>
    </OnboardingFrame>
  );
}
