import type { GitHubStatus, HobGitHubAppStatus, HobPermissions } from "@hobbots/api";
import { type Agent, holdsCharm } from "@hobbots/domain";
import { Badge } from "@hobbots/ui/components/badge";
import { Skeleton, WaitNote } from "@hobbots/ui/components/skeleton";
import { Switch } from "@hobbots/ui/components/switch";
import { cn } from "@hobbots/ui/lib/utils";
import { useWaitStage, type Wait } from "@hobbots/ui/lib/wait-stage";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useId } from "react";
import { githubStatusQuery } from "../../api/github.ts";
import { hobGitHubAppQuery } from "../../api/hob-github-app.ts";
import { useUpdatePermissions } from "../../api/queries.ts";
import { sendingCharm, switchCharm } from "../../api/safety.ts";
import { messages } from "../messages.ts";
import { GitHubRules } from "./github-rules.tsx";
import { HobGitHubApp } from "./hob-github-app.tsx";
import { CardSaveOutcome } from "./saved-bar.tsx";

/** Where the GitHub Charm stands, for the tag beside its name. */
type CharmState = "off" | "on" | "as-you" | "not-ready" | "cannot-act";

const STATE_BADGE = {
  off: "resting",
  on: "working",
  "as-you": "working",
  "not-ready": "needs-you",
  "cannot-act": "failed",
} as const satisfies Record<CharmState, string>;

/**
 * The GitHub Charm (#317, ADR 020): it reads, pushes, opens pull requests and comments in the
 * repository of the hob's folders on the hub, as you or as the hob's own app (ADR 022), so it needs
 * no sandbox and no credential reaches the hob. The card turns it on for this hob, says who it acts
 * as, and sets Allow, Ask or Never for each of its actions. Every change is saved at once.
 *
 * Its frame is drawn at once (Patterns › Loading). Until the hub and GitHub answer, a block holds
 * the place of its tag, its switch and each answer, and after a second one line says it is checking
 * GitHub, which offers Try again after ten.
 */
export function GitHubCharm({
  hob,
  permissions,
  outdated,
  retry,
}: {
  hob: Agent;
  /** The hob's permissions, or undefined while the hub reads them. */
  permissions: HobPermissions | undefined;
  outdated: boolean;
  retry: () => void;
}) {
  const copy = messages.charms.github;
  const update = useUpdatePermissions(hob.id);
  const switchId = useId();
  const sending = update.isPending ? update.variables : undefined;
  const charm = useCharmStatus(hob, permissions, sendingCharm(sending, "github"));
  const { granted, waiting } = charm;
  const wait = useWaitStage(waiting);

  return (
    <section
      aria-label={copy.card}
      aria-busy={waiting}
      className={cn(
        "flex flex-col rounded-card bg-card",
        granted && !waiting
          ? "shadow-[inset_0_0_0_1px_var(--color-line),inset_0_3px_0_var(--color-mint-deep)]"
          : "shadow-[inset_0_0_0_1px_var(--color-line)]",
      )}
    >
      <div className="flex items-center gap-3.5 px-4.5 py-4">
        <CharmMark off={!granted} />
        <CharmTitle switchId={switchId} state={charm.state} reads={charm.reads} />
        {permissions === undefined ? (
          <Skeleton shape="dot" surface="card" className="h-6 w-[46px]" />
        ) : (
          <Switch
            id={switchId}
            aria-label={copy.grant({ name: hob.name })}
            checked={granted}
            disabled={update.isPending}
            onCheckedChange={(on) => update.mutate(switchCharm(permissions, "github", on))}
          />
        )}
      </div>

      {granted ? (
        <div className="flex animate-hb-in flex-col gap-4.5 ps-16 pe-4.5 pb-4.5">
          <HobGitHubApp hob={hob} />
          <GitHubRules
            name={hob.name}
            permissions={permissions}
            sending={sending}
            pending={update.isPending || outdated}
            onPick={(change) => update.mutate(change)}
          />
        </div>
      ) : (
        <span className="animate-hb-in ps-16 pe-4.5 pb-4 text-ui text-text-secondary">
          {copy.off({ name: hob.name })}
        </span>
      )}
      {waiting && (
        <CharmWaitNote
          wait={wait}
          onRetry={() => {
            if (permissions === undefined) retry();
            charm.refetch();
          }}
        />
      )}
      {!charm.connected && (
        <span className="ps-16 pe-4.5 pb-4 text-detail text-text-secondary">
          {copy.notConnected}{" "}
          <Link
            to="/settings/$section"
            params={{ section: "connections" }}
            search={{ tab: "charms" }}
            className="text-link underline"
          >
            {copy.connectInSettings}
          </Link>
        </span>
      )}
      <CardSaveOutcome hob={hob} save={update} failed={copy.saveFailed} />
    </section>
  );
}

/**
 * Where the Charm stands for this hob, from its permissions, the GitHub account and the hob's own
 * app. While any of them is still read, `waiting` is true and the tag and who it acts as are null.
 */
const useCharmStatus = (hob: Agent, permissions: HobPermissions | undefined, sending: boolean | undefined) => {
  const copy = messages.charms.github;
  const github = useQuery(githubStatusQuery);
  // A hob with its own app acts as its bot, so it needs no account connected in Settings (ADR 022).
  const ownAppStatus = useQuery(hobGitHubAppQuery(hob.id));
  const ownApp = ownAppStatus.data;
  const waiting = permissions === undefined || github.isPending || ownAppStatus.isPending;
  // Until the hub answers, the card is drawn as the Charm starts: on, unless turned off.
  const granted = sending ?? (permissions === undefined || holdsCharm(permissions.policy, "github"));
  const bot = ownApp?._tag === "Connected" ? ownApp.bot : null;
  const connected = bot !== null || accountReady(github.data);
  const reads = bot === null ? copy.reads({ name: hob.name }) : copy.readsAsBot({ name: hob.name, bot });
  return {
    waiting,
    granted,
    connected,
    state: waiting ? null : charmState(granted, ownApp, connected),
    reads: ownAppStatus.isPending ? null : reads,
    refetch: () => {
      void github.refetch();
      void ownAppStatus.refetch();
    },
  };
};

/** The Charm's name with its tag, and who it acts as, with a block for each while it is unknown. */
function CharmTitle({ switchId, state, reads }: { switchId: string; state: CharmState | null; reads: string | null }) {
  const copy = messages.charms.github;
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <span className="flex flex-wrap items-center gap-2">
        <label htmlFor={switchId} className="text-title font-bold text-text-strong">
          {copy.name}
        </label>
        {state === null ? (
          <Skeleton shape="block" surface="card" width="9ch" />
        ) : (
          <Badge variant={STATE_BADGE[state]}>{copy.state[state]}</Badge>
        )}
      </span>
      <span className="text-detail text-text-secondary">{reads ?? <Skeleton surface="card" width="40ch" />}</span>
    </div>
  );
}

/** The card's wait line: it takes no room until it shows, after a second. */
function CharmWaitNote({ wait, onRetry }: { wait: Wait; onRetry: () => void }) {
  const copy = messages.charms.github;
  return (
    <div className={cn("ps-16 pe-4.5", wait.stage !== "none" && "pb-4")}>
      <WaitNote wait={wait} detail={copy.checking} outside={{ note: copy.slow, retryLabel: copy.retry, onRetry }} />
    </div>
  );
}

/** A Charm's mark before its name, faded while the Charm is off: GitHub's monogram unless another is given. */
export const CharmMark = ({ off, mark }: { off: boolean; mark?: string }) => (
  <span
    aria-hidden
    className={cn(
      "grid size-9 flex-none place-items-center rounded-control bg-text-strong font-heading text-[17px] font-bold text-ground",
      off && "opacity-55",
    )}
  >
    {mark ?? "G"}
  </span>
);

/** Whether a GitHub account is ready for the hob to act as you; unknown counts as ready. */
const accountReady = (status: GitHubStatus | undefined): boolean =>
  status === undefined || status._tag === "Connected" || status._tag === "Environment";

/** Where the Charm stands: off, unable to act, acting as its own app or as you, or not ready yet. */
const charmState = (granted: boolean, ownApp: HobGitHubAppStatus | undefined, connected: boolean): CharmState => {
  if (!granted) return "off";
  if (ownApp?._tag === "Connected") return ownApp.needsReconnect === null ? "on" : "cannot-act";
  return connected ? "as-you" : "not-ready";
};
