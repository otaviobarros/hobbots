import type { RuntimeHealth, RuntimeKind } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { cn } from "@hobbots/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { useCanGoBack, useNavigate, useRouter } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { runtimesQuery } from "../api/queries.ts";
import { canContinueSetup, claudeInstallGuide, codexInstallGuide, runtimeProblem } from "../api/runtime-health.ts";
import { useUpdateSetup, watchedSetupQuery } from "../api/setup.ts";
import { formatCount, plural } from "../lib/format.ts";
import { connectedLines, PROVIDER_MAKERS, PROVIDER_MARKS, PROVIDER_NAMES, PROVIDERS } from "../lib/providers.ts";
import { OnboardingFrame } from "./onboarding-frame.tsx";
import { providerFix } from "./provider-fix.tsx";

const GUIDE = {
  looking: "Welcome, friend! Let me peek around your Mac for an AI helper you already use.",
  found: (name: string) => `There it is! ${name} is ready on this Mac. Connect it, and your hobs will think with it.`,
  connected: "Splendid! That door is open, so your hobs can think with it. Continue when you like.",
  fix: "Your hobs need an AI to think with. Each one here needs a little fix first; follow the steps, then check again.",
  nudge: "Connect one provider first, otherwise the hobs have nothing to think with!",
};

const INSTALL_GUIDES: Readonly<Record<RuntimeKind, string>> = {
  "claude-code": claudeInstallGuide,
  codex: codexInstallGuide,
};

// Providers from the Hobbots design that arrive in a later slice.
const LATER = [
  { name: "Gemini", maker: "Google", mark: "G", tile: "#8fb4f0", how: "Sign in with your Google account." },
  { name: "Grok", maker: "xAI", mark: "X", tile: "#c9c3e8", how: "Paste an API key from your xAI account." },
  {
    name: "Local models",
    maker: "Ollama · LM Studio",
    mark: "L",
    tile: "#f3e9b5",
    how: "Free, private, stays on this Mac.",
  },
  {
    name: "Other",
    maker: "OpenRouter · any API",
    mark: "+",
    tile: "#b79be8",
    how: "Any OpenAI-compatible key.",
  },
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
  found: { label: "Found", className: "bg-moonlight text-ground" },
  connected: { label: "Found", className: "bg-moonlight text-ground" },
  notFound: { label: "Not found", className: "bg-line-2 text-text" },
  notStarted: { label: "Not working", className: "bg-rose text-ground" },
  outdated: { label: "Update needed", className: "bg-rose text-ground" },
  signedOut: { label: "Signed out", className: "bg-lantern text-ground" },
  unknown: { label: "Unknown", className: "bg-line-2 text-text" },
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
  switch (state) {
    case "checking":
      return "Looking for Claude Code on this Mac.";
    case "found":
    case "connected":
      return `Claude Code${claude?.version ? ` ${claude.version}` : ""} is signed in on this Mac.`;
    case "notFound":
      return "Claude Code is not on this Mac yet. Install it, sign in once in Terminal, then check again.";
    case "notStarted":
      return (
        <>
          Claude Code is installed but did not start. Run <code>claude</code> in Terminal to see what is wrong.
        </>
      );
    case "outdated":
      return `Claude Code${claude?.version ? ` ${claude.version}` : ""} is too old for Hobbots.`;
    case "signedOut":
      return (
        <>
          Claude Code is installed but not signed in. Run <code>claude</code> in Terminal and sign in with your
          claude.ai account.
        </>
      );
    case "unknown":
      return "Hobbots could not check Claude Code just now.";
  }
};

/** What a Codex card says, with the same fixes as Settings for each state that stops it. */
const codexHow = (state: ProviderState, codex: RuntimeHealth | undefined): ReactNode => {
  switch (state) {
    case "checking":
      return "Looking for Codex on this Mac.";
    case "found":
    case "connected":
      return `Codex${codex?.version ? ` ${codex.version}` : ""} is signed in with your ChatGPT plan on this Mac.`;
    case "unknown":
      return "Hobbots could not check Codex just now.";
    default:
      return providerFix("codex", codex);
  }
};

const how = (runtime: RuntimeKind, state: ProviderState, health: RuntimeHealth | undefined): ReactNode =>
  runtime === "codex" ? codexHow(state, health) : claudeHow(state, health);

function ProviderMark({ mark, tile, style }: { mark: string; tile?: string; style?: React.CSSProperties }) {
  return (
    <span
      aria-hidden
      className={cn("cut grid size-9 flex-none place-items-center text-[19px] font-bold text-ground", tile)}
      style={style}
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
  return runtime === "codex" ? "Your ChatGPT plan" : "Your Claude plan";
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
          <>
            Run <code>claude update</code> in Terminal. Your sign-in stays as it is.
          </>
        ) : (
          "No need to restart Hobbots after fixing it."
        )}
      </span>
      <CardFooter>
        {state === "notFound" && (
          <Button asChild variant="outline" size="sm">
            <a href={INSTALL_GUIDES[runtime]} target="_blank" rel="noreferrer">
              Install guide
            </a>
          </Button>
        )}
        <Button variant="outline" size="sm" className="ml-auto border-lantern" onClick={onCheckAgain}>
          Check again
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
  onCheckAgain,
  onConnect,
  onDisconnect,
}: ProviderCardProps) {
  const name = PROVIDER_NAMES[runtime];
  const ready = state === "found" || state === "connected";
  if (saving) {
    return (
      <CardFooter>
        <Busy>{saving === "connect" ? "Knocking on the door" : "Closing the door"}</Busy>
      </CardFooter>
    );
  }
  if (state === "checking" || (checking && !ready)) {
    return (
      <CardFooter>
        <Busy>Looking on this Mac</Busy>
      </CardFooter>
    );
  }
  if (state === "found") {
    return (
      <CardFooter>
        <span className="text-[13px] text-label">Not connected</span>
        <Button variant="outline" size="sm" className="flex-none" aria-label={`Connect ${name}`} onClick={onConnect}>
          Connect
        </Button>
      </CardFooter>
    );
  }
  if (state === "connected") {
    const plan = planLine(runtime, health);
    return (
      <CardFooter>
        <span className="flex min-w-0 flex-col leading-tight">
          <span className="animate-hb-pop truncate text-sm font-bold text-mint">✓ Connected</span>
          {plan && <span className="truncate text-[13px] text-secondary-text">{plan}</span>}
        </span>
        <Button
          variant="outline"
          size="sm"
          className="flex-none"
          aria-label={`Disconnect ${name}`}
          onClick={onDisconnect}
        >
          Disconnect
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
          <span className="text-[13px] text-secondary-text">{PROVIDER_MAKERS[runtime]}</span>
        </div>
        {tag && <span className={`px-[7px] py-0.5 text-xs font-bold ${tag.className}`}>{tag.label}</span>}
      </div>
      <span className="min-h-9 text-[13px] leading-snug text-secondary-text">{how(runtime, state, health)}</span>
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
  if (ready) return GUIDE.connected;
  if (nudged) return GUIDE.nudge;
  if (states.some(([, state]) => state === "checking")) return GUIDE.looking;
  const found = states.find(([, state]) => state === "found");
  return found ? GUIDE.found(PROVIDER_NAMES[found[0]]) : GUIDE.fix;
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

  const change = (runtime: RuntimeKind, connect: boolean) => {
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
            Back
          </Button>
          <span
            id="providers-hint"
            role={failed ? "alert" : undefined}
            className={`flex-1 text-right text-sm ${failed ? "text-rose" : ready ? "text-secondary-text" : "text-lantern"}`}
          >
            {failed
              ? "Hobbots could not save that. Try again in a moment."
              : ready
                ? plural(count, {
                    one: "1 provider connected",
                    other: `${formatCount(count)} providers connected`,
                  })
                : "Connect at least one to continue"}
          </span>
          <Button
            onClick={next}
            aria-disabled={!ready}
            aria-describedby="providers-hint"
            disabled={providers.isPending}
            className={
              ready ? undefined : "cursor-not-allowed bg-line-2 text-label shadow-[0_4px_0_#22203f] hover:bg-line-2"
            }
          >
            Continue
          </Button>
        </>
      }
    >
      <div className="flex animate-hb-in flex-col gap-1.5">
        <h1 className="m-0 font-pixel text-[30px] font-bold text-moonlight">Which AI do you already use?</h1>
        <p className="m-0 mb-3.5 text-secondary-text">
          Hobs think with your own subscription or key. Either one is enough, and you can change this any time in
          Settings.
        </p>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
          {states.map(([runtime, state]) => (
            <ProviderCard
              key={runtime}
              runtime={runtime}
              state={state}
              health={healthOf(runtime)}
              checking={runtimes.isFetching}
              saving={savingFor(runtime)}
              onCheckAgain={() => void runtimes.refetch()}
              onConnect={() => change(runtime, true)}
              onDisconnect={() => change(runtime, false)}
            />
          ))}
          {LATER.map((p) => (
            <section
              key={p.name}
              aria-label={`${p.name}, coming later`}
              className="cut flex flex-col gap-2.5 border-2 border-line-2 bg-card p-3.5"
            >
              <div className="flex items-center gap-2.5">
                <ProviderMark mark={p.mark} style={{ background: p.tile }} />
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="text-base font-bold">{p.name}</span>
                  <span className="text-[13px] text-secondary-text">{p.maker}</span>
                </div>
                <span className="bg-lantern px-[7px] py-0.5 text-xs font-bold text-ground">Later</span>
              </div>
              <span className="min-h-9 text-[13px] leading-snug text-secondary-text">{p.how}</span>
              <CardFooter>
                <span className="text-[13px] text-label">Arrives in a later version</span>
              </CardFooter>
            </section>
          ))}
        </div>
        <p className="mt-3 mb-0 text-[13px] text-label">
          Hobbots never sees your password. It reuses the tool already signed in on this Mac.
        </p>
      </div>
    </OnboardingFrame>
  );
}
