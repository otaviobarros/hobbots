import type { RuntimeHealth, RuntimeKind } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { cn } from "@hobbots/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { useCanGoBack, useNavigate, useRouter } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { runtimesQuery } from "../../api/queries.ts";
import { canContinueSetup, claudeInstallGuide, codexInstallGuide, runtimeProblem } from "../../api/runtime-health.ts";
import { useUpdateSetup, watchedSetupQuery } from "../../api/setup.ts";
import { PROVIDER_MAKERS, PROVIDER_MARKS, PROVIDER_NAMES, PROVIDERS } from "../../lib/providers.ts";
import { messages } from "../messages.ts";
import { providerFix, WithCommand } from "../providers/provider-fix.tsx";
import { OnboardingFrame, type PreviewChip } from "./onboarding-frame.tsx";
import { setupSummary } from "./onboarding-preview.ts";

const shared = messages.onboarding;
const copy = messages.onboarding.providers;

const INSTALL_GUIDES: Readonly<Record<RuntimeKind, string>> = {
  "claude-code": claudeInstallGuide,
  codex: codexInstallGuide,
};

const RECHECK_MS = 5000;

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
  notStarted: { label: copy.tags.notStarted, className: "bg-rose text-on-rose" },
  outdated: { label: copy.tags.outdated, className: "bg-rose text-on-rose" },
  signedOut: { label: copy.tags.signedOut, className: "bg-rose text-on-rose" },
  unknown: { label: copy.tags.unknown, className: "bg-line-2 text-text-strong" },
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

function ProviderMark({ mark, tile, small = false }: { mark: string; tile: string; small?: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "grid flex-none place-items-center rounded-control font-bold text-provider-ink",
        small ? "size-[26px] text-detail" : "size-9",
        tile,
      )}
    >
      {mark}
    </span>
  );
}

/** A wait the card is in: looking for the provider, or saving the user's Connect or Disconnect. */
function Busy({ children }: { children: ReactNode }) {
  return (
    <span className="flex items-center gap-2 text-ui text-text-secondary">
      <span
        aria-hidden
        className="size-3.5 animate-hb-spin rounded-full border-2 border-line-2 border-t-moonlight motion-reduce:animate-none"
      />
      {children}
    </span>
  );
}

/** The plan a ready provider bills, in the user's words where Hobbots knows them. */
const planLine = (runtime: RuntimeKind, health: RuntimeHealth | undefined) => {
  const onSubscription = health?.billing?.startsWith("subscription") ?? false;
  if (!onSubscription) return health?.billing;
  return messages.providers.plan[runtime];
};

/** Under a provider that needs a fix: its install guide when missing, Check again, and that it checks by itself. */
function FixActions({
  runtime,
  state,
  onCheckAgain,
}: {
  runtime: RuntimeKind;
  state: ProviderState;
  onCheckAgain: () => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      {state === "outdated" && runtime === "claude-code" && (
        <span className="text-ui text-text-secondary">
          <WithCommand text={copy.claude.update} command={copy.claude.updateCommand} />
        </span>
      )}
      <span className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={onCheckAgain}>
          {copy.checkAgain}
        </Button>
        {state === "notFound" && (
          <Button asChild variant="outline" size="sm">
            <a href={INSTALL_GUIDES[runtime]} target="_blank" rel="noreferrer">
              {copy.installGuide}
            </a>
          </Button>
        )}
        <span className="text-detail text-label">{copy.checksItself}</span>
      </span>
    </div>
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

/** The right of a card's header: the wait, Connect, Connected with Disconnect, or the problem's tag. */
function ProviderStatus({ runtime, state, checking, saving, locked, onConnect, onDisconnect }: ProviderCardProps) {
  const name = PROVIDER_NAMES[runtime];
  const ready = state === "found" || state === "connected";
  if (saving) return <Busy>{saving === "connect" ? copy.connecting : copy.disconnecting}</Busy>;
  if (state === "checking" || (checking && !ready)) return <Busy>{copy.looking}</Busy>;
  if (state === "found") {
    return (
      <Button
        className="flex-none"
        aria-label={copy.connectLabel({ provider: name })}
        disabled={locked}
        onClick={onConnect}
      >
        {copy.connect}
      </Button>
    );
  }
  if (state === "connected") {
    return (
      <span className="flex flex-none items-center gap-2">
        <span className="animate-hb-pop rounded-tag bg-mint px-2 py-0.5 text-detail font-bold text-ground">
          {copy.connected}
        </span>
        <Button
          variant="ghost"
          size="sm"
          aria-label={copy.disconnectLabel({ provider: name })}
          disabled={locked}
          onClick={onDisconnect}
        >
          {copy.disconnect}
        </Button>
      </span>
    );
  }
  const tag = TAG[state];
  return tag ? (
    <span className={cn("rounded-tag px-2 py-0.5 text-detail font-bold", tag.className)}>{tag.label}</span>
  ) : null;
}

/** What a card says under its header: why it is ready, which plan it bills, or the fix. */
function ProviderBody(props: ProviderCardProps) {
  const { runtime, state, health, checking, saving, onCheckAgain } = props;
  if (state === "checking" || (checking && state !== "found" && state !== "connected" && !saving)) return null;
  const plan = state === "connected" ? planLine(runtime, health) : undefined;
  const fixing = state !== "found" && state !== "connected";
  return (
    <div className="flex flex-col gap-2.5">
      <span className="text-ui leading-5 text-text-secondary">
        {how(runtime, state, health)}
        {plan && <span className="block">{plan}</span>}
      </span>
      {fixing && <FixActions runtime={runtime} state={state} onCheckAgain={onCheckAgain} />}
    </div>
  );
}

/** One provider found, or not, on this computer: its state, what it means and what to do. */
function ProviderCard(props: ProviderCardProps) {
  const { runtime } = props;
  const look = PROVIDER_MARKS[runtime];
  const headingId = `provider-${runtime}`;
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3 rounded-card bg-card p-[18px]">
      <div className="flex items-center gap-3">
        <ProviderMark mark={look.mark} tile={look.tile} />
        <div className="flex min-w-0 flex-1 flex-col">
          <h2 id={headingId} className="m-0 text-[17px] font-bold">
            {PROVIDER_NAMES[runtime]}
          </h2>
          <span className="text-detail text-text-secondary">{PROVIDER_MAKERS[runtime]}</span>
        </div>
        <ProviderStatus {...props} />
      </div>
      <ProviderBody {...props} />
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

type States = ReadonlyArray<readonly [RuntimeKind, ProviderState]>;

/** The AI tag over the preview's sky: looking, the provider found or connected, or that it needs a fix. */
const previewChip = (states: States): PreviewChip => {
  const connected = states.find(([, state]) => state === "connected");
  if (connected) return { label: PROVIDER_NAMES[connected[0]], tone: "connected" };
  if (states.some(([, state]) => state === "checking")) return { label: copy.preview.looking, tone: "looking" };
  const found = states.find(([, state]) => state === "found");
  if (found) return { label: copy.preview.found({ provider: PROVIDER_NAMES[found[0]] }), tone: "found" };
  const first = states[0]?.[1];
  return { label: first && TAG[first] ? (TAG[first]?.label ?? "") : copy.preview.fix, tone: "problem" };
};

const captionFor = (states: States): string => {
  if (states.some(([, state]) => state === "connected")) return copy.preview.connected;
  if (states.some(([, state]) => state === "checking")) return copy.preview.lookingCaption;
  return copy.preview.notYet;
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
  // While no provider is ready, it checks again every few seconds, so a fix in a terminal shows by itself.
  const runtimes = useQuery({
    ...runtimesQuery,
    refetchInterval: (query) => (query.state.data?.some((h) => h.availability === "ready") ? false : RECHECK_MS),
  });
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

  const back = () => (canGoBack ? router.history.back() : void navigate({ to: "/setup/where" }));
  const next = () => {
    if (!ready) return setNudged(true);
    void navigate({ to: "/setup/hob" });
  };

  const failed = providers.isError;
  const count = readyConnected.length;

  return (
    <OnboardingFrame
      step={0}
      preview={{
        chip: previewChip(states),
        hob: "ghost",
        caption: captionFor(states),
        speech: guide,
        summary: setupSummary(0, undefined, null),
      }}
      footer={
        <>
          <span
            id="providers-hint"
            role={failed ? "alert" : undefined}
            className={`flex-1 text-detail ${failed ? "text-rose" : ready ? "text-text-secondary" : "text-label"}`}
          >
            {failed ? copy.saveFailed : ready ? messages.providers.connectedCount({ count }) : copy.connectOne}
          </span>
          <Button variant="outline" onClick={back}>
            {shared.back}
          </Button>
          <Button
            onClick={next}
            aria-disabled={!ready}
            aria-describedby="providers-hint"
            disabled={providers.isPending}
            className={
              ready ? undefined : "cursor-not-allowed bg-line-2 text-label [--press-color:transparent] hover:bg-line-2"
            }
          >
            {shared.continue}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <h1 className="m-0 font-heading text-[30px] font-bold text-moonlight">{copy.heading}</h1>
          <p className="m-0 text-text-secondary">{copy.intro}</p>
        </div>
        {states.map(([runtime, state]) => (
          <ProviderCard
            key={runtime}
            runtime={runtime}
            state={state}
            health={healthOf(runtime)}
            checking={runtimes.isFetching && state === "checking"}
            saving={savingFor(runtime)}
            locked={providers.isPending}
            onCheckAgain={() => void runtimes.refetch()}
            onConnect={() => change(runtime, true)}
            onDisconnect={() => change(runtime, false)}
          />
        ))}
        <span className="lbl text-label">{copy.later.heading}</span>
        <div className="flex flex-col gap-1.5">
          {LATER.map((p) => (
            <section
              key={p.name}
              aria-label={copy.later.label({ provider: p.name })}
              className="flex items-center gap-3 rounded-control bg-card px-3.5 py-2.5"
            >
              <ProviderMark mark={p.mark} tile={p.tile} small />
              <span className="flex min-w-0 flex-1 flex-col">
                <strong className="text-[15px]">{p.name}</strong>
                <span className="truncate text-detail text-text-secondary">{p.how}</span>
              </span>
              <span className="flex-none rounded-tag bg-line-2 px-2 py-0.5 text-detail font-bold">
                {copy.later.tag}
              </span>
            </section>
          ))}
        </div>
        <p className="m-0 text-detail text-label">{copy.privacy}</p>
      </div>
    </OnboardingFrame>
  );
}
