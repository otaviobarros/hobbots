import type { RuntimeHealth, RuntimeKind } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { useQuery } from "@tanstack/react-query";
import { useCanGoBack, useNavigate, useRouter } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { runtimesQuery } from "../api/queries.ts";
import { canContinueSetup, claudeInstallGuide, runtimeProblem } from "../api/runtime-health.ts";
import { useUpdateSetup, watchedSetupQuery } from "../api/setup.ts";
import { OnboardingFrame } from "./onboarding-frame.tsx";

const GUIDE = {
  looking: "Welcome, friend! Let me peek around your Mac for an AI helper you already use.",
  found: "There it is! Claude Code is ready on this Mac. Connect it, and your hobs will think with it.",
  connected: "Splendid! That door is open, so your hobs can think with Claude. Continue when you like.",
  fix: "Your hobs need an AI to think with. Claude Code needs a little fix first; follow the steps, then check again.",
  nudge: "Connect one provider first, otherwise the hobs have nothing to think with!",
};

// Providers from the Hobbots design that arrive in a later slice.
const LATER = [
  { name: "ChatGPT", maker: "OpenAI · Codex", mark: "G", tile: "#8fd3a8", how: "Sign in with your ChatGPT plan." },
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

const CLAUDE: RuntimeKind = "claude-code";

/** Found and connected are both a ready Claude Code; only the user's Connect turns one into the other. */
type ClaudeState =
  | "checking"
  | "found"
  | "connected"
  | "notFound"
  | "notStarted"
  | "outdated"
  | "signedOut"
  | "unknown";

const claudeState = (
  pending: boolean,
  failed: boolean,
  claude: RuntimeHealth | undefined,
  connected: boolean,
): ClaudeState => {
  if (pending) return "checking";
  if (claude?.availability === "ready") return connected ? "connected" : "found";
  return (failed ? null : runtimeProblem(claude)) ?? "unknown";
};

const TAG: Record<ClaudeState, { label: string; className: string } | null> = {
  checking: null,
  found: { label: "Found", className: "bg-moonlight text-ground" },
  connected: { label: "Found", className: "bg-moonlight text-ground" },
  notFound: { label: "Not found", className: "bg-line-2 text-text" },
  notStarted: { label: "Not working", className: "bg-rose text-ground" },
  outdated: { label: "Update needed", className: "bg-rose text-ground" },
  signedOut: { label: "Signed out", className: "bg-lantern text-ground" },
  unknown: { label: "Unknown", className: "bg-line-2 text-text" },
};

const BORDER: Record<ClaudeState, string> = {
  checking: "border-lantern",
  found: "border-control",
  connected: "border-mint",
  notFound: "border-line-2",
  notStarted: "border-rose",
  outdated: "border-rose",
  signedOut: "border-control",
  unknown: "border-line-2",
};

const how = (state: ClaudeState, claude: RuntimeHealth | undefined): ReactNode => {
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

function ProviderMark({ mark, tile }: { mark: string; tile: string }) {
  return (
    <span
      aria-hidden
      className="cut grid size-9 flex-none place-items-center text-[19px] font-bold text-ground"
      style={{ background: tile }}
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

function ClaudeCard({
  state,
  claude,
  checking,
  saving,
  onCheckAgain,
  onConnect,
  onDisconnect,
}: {
  state: ClaudeState;
  claude: RuntimeHealth | undefined;
  checking: boolean;
  saving: "connect" | "disconnect" | null;
  onCheckAgain: () => void;
  onConnect: () => void;
  onDisconnect: () => void;
}) {
  const tag = TAG[state];
  const onSubscription = claude?.billing?.startsWith("subscription") ?? false;
  const plan = onSubscription ? "Your Claude plan" : claude?.billing;
  const ready = state === "found" || state === "connected";
  return (
    <section
      aria-labelledby="provider-claude"
      className={`cut flex flex-col gap-2.5 border-2 bg-card p-3.5 ${saving ? "border-lantern" : BORDER[state]}`}
    >
      <div className="flex items-center gap-2.5">
        <ProviderMark mark="C" tile="#e39a74" />
        <div className="flex min-w-0 flex-1 flex-col">
          <h2 id="provider-claude" className="m-0 text-base font-bold">
            Claude
          </h2>
          <span className="text-[13px] text-secondary-text">Anthropic · Claude Code</span>
        </div>
        {tag && <span className={`px-[7px] py-0.5 text-xs font-bold ${tag.className}`}>{tag.label}</span>}
      </div>
      <span className="min-h-9 text-[13px] leading-snug text-secondary-text">{how(state, claude)}</span>

      {saving ? (
        <CardFooter>
          <Busy>{saving === "connect" ? "Knocking on the door" : "Closing the door"}</Busy>
        </CardFooter>
      ) : state === "checking" || (checking && !ready) ? (
        <CardFooter>
          <Busy>Looking on this Mac</Busy>
        </CardFooter>
      ) : state === "found" ? (
        <CardFooter>
          <span className="text-[13px] text-label">Not connected</span>
          <Button variant="outline" size="sm" className="flex-none" aria-label="Connect Claude" onClick={onConnect}>
            Connect
          </Button>
        </CardFooter>
      ) : state === "connected" ? (
        <CardFooter>
          <span className="flex min-w-0 flex-col leading-tight">
            <span className="animate-hb-pop truncate text-sm font-bold text-mint">✓ Connected</span>
            {plan && <span className="truncate text-[13px] text-secondary-text">{plan}</span>}
          </span>
          <Button
            variant="outline"
            size="sm"
            className="flex-none"
            aria-label="Disconnect Claude"
            onClick={onDisconnect}
          >
            Disconnect
          </Button>
        </CardFooter>
      ) : (
        <>
          <span className="text-xs text-label">
            {state === "outdated" ? (
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
                <a href={claudeInstallGuide} target="_blank" rel="noreferrer">
                  Install guide
                </a>
              </Button>
            )}
            <Button variant="outline" size="sm" className="ml-auto border-lantern" onClick={onCheckAgain}>
              Check again
            </Button>
          </CardFooter>
        </>
      )}
    </section>
  );
}

/**
 * Onboarding step 1: the providers found on this computer. A ready Claude Code shows as found
 * until the user connects it; the choice is stored on the hub, and setup continues once a
 * connected provider is ready. Each problem shows its fix and Check again, so fixing it in a
 * terminal is enough, without restarting Hobbots.
 */
export function OnboardingProviders() {
  const navigate = useNavigate();
  const router = useRouter();
  const canGoBack = useCanGoBack();
  const finish = useUpdateSetup();
  const providers = useUpdateSetup();
  const runtimes = useQuery(runtimesQuery);
  // Another window or device may connect or disconnect a provider while this step is open.
  const setup = useQuery(watchedSetupQuery);
  const connected = setup.data?.connectedProviders ?? [];
  const claude = runtimes.data?.find((health) => health.runtime === CLAUDE);
  const state = claudeState(
    runtimes.isPending || setup.isPending,
    runtimes.isError,
    claude,
    connected.includes(CLAUDE),
  );
  const ready = canContinueSetup(runtimes.data, connected);
  const [nudged, setNudged] = useState(false);

  const saving = providers.isPending
    ? providers.variables.connectedProviders?.includes(CLAUDE)
      ? "connect"
      : "disconnect"
    : null;
  const connect = () => {
    setNudged(false);
    providers.mutate({ connectedProviders: [...connected.filter((kind) => kind !== CLAUDE), CLAUDE] });
  };
  const disconnect = () => providers.mutate({ connectedProviders: connected.filter((kind) => kind !== CLAUDE) });

  const guide = ready
    ? GUIDE.connected
    : nudged
      ? GUIDE.nudge
      : state === "checking"
        ? GUIDE.looking
        : state === "found"
          ? GUIDE.found
          : GUIDE.fix;

  const back = () => (canGoBack ? router.history.back() : void navigate({ to: "/setup/where" }));
  // The first-hob step (#68) takes over from here; until it exists, setup ends on Home.
  const next = () => {
    if (!ready) return setNudged(true);
    finish.mutate({ completed: true }, { onSuccess: () => navigate({ to: "/" }) });
  };

  const failed = finish.isError || providers.isError;

  return (
    <OnboardingFrame
      step={0}
      guide={guide}
      sofar={ready ? ["Claude connected"] : []}
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
                ? "1 provider connected"
                : "Connect at least one to continue"}
          </span>
          <Button
            onClick={next}
            aria-disabled={!ready}
            aria-describedby="providers-hint"
            disabled={finish.isPending || providers.isPending}
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
          Hobs think with your own subscription or key. You can change this any time in Settings.
        </p>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
          <ClaudeCard
            state={state}
            claude={claude}
            checking={runtimes.isFetching}
            saving={saving}
            onCheckAgain={() => void runtimes.refetch()}
            onConnect={connect}
            onDisconnect={disconnect}
          />
          {LATER.map((p) => (
            <section
              key={p.name}
              aria-label={`${p.name}, coming later`}
              className="cut flex flex-col gap-2.5 border-2 border-line-2 bg-card p-3.5"
            >
              <div className="flex items-center gap-2.5">
                <ProviderMark mark={p.mark} tile={p.tile} />
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
