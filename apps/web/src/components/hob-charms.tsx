import type { GitHubStatus, HobGitHubAppStatus, HobPermissions, UpdateHobPermissionsPayload } from "@hobbots/api";
import type { Agent, PolicyOverrides } from "@hobbots/domain";
import { Badge } from "@hobbots/ui/components/badge";
import { Button } from "@hobbots/ui/components/button";
import { Switch } from "@hobbots/ui/components/switch";
import { cn } from "@hobbots/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useId } from "react";
import { githubStatusQuery } from "../api/github.ts";
import { hobGitHubAppQuery } from "../api/hob-github-app.ts";
import { useUpdatePermissions } from "../api/queries.ts";
import { GITHUB_OPERATIONS, pickAnswer, RULES, type RuleInfo } from "../api/safety.ts";
import { HobGitHubApp } from "./hob-github-app.tsx";
import { Loading, Rule, shownAnswer, useHobPermissions } from "./hob-permissions.tsx";
import { messages } from "./messages.ts";

/**
 * The hob's Charms (ADR 014): one card for each app connected in Settings, each with who the hob
 * acts as there and what it may do. GitHub is the only Charm so far.
 */
export function CharmsTab({ hob }: { hob: Agent }) {
  const copy = messages.charms;
  const permissions = useHobPermissions(hob);
  const data = permissions.data;
  if (!data) {
    return <Loading name={hob.name} failed={permissions.isError} retry={() => void permissions.refetch()} />;
  }
  return (
    <div className="flex max-w-[760px] flex-col gap-4">
      <span className="text-text-secondary">{copy.intro({ name: hob.name })}</span>
      <GitHubCharm hob={hob} permissions={data} outdated={permissions.outdated} />
      <div className="flex items-center gap-3 rounded-card border-(length:--edge) border-dashed border-line-2 px-4 py-3.5">
        <span className="flex-1 text-sm text-text-secondary">{copy.more}</span>
        <Button asChild variant="outline">
          <Link to="/settings/$section" params={{ section: "connections" }} search={{ tab: "charms" }}>
            {copy.moreLink}
          </Link>
        </Button>
      </div>
    </div>
  );
}

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
 */
function GitHubCharm({ hob, permissions, outdated }: { hob: Agent; permissions: HobPermissions; outdated: boolean }) {
  const copy = messages.charms.github;
  const update = useUpdatePermissions(hob.id);
  const github = useQuery(githubStatusQuery);
  const switchId = useId();
  const sending = update.isPending ? update.variables : undefined;
  const granted = sending?.githubCharm !== undefined ? sending.githubCharm : permissions.policy.githubCharm !== false;
  // A hob with its own app acts as its bot, so it needs no account connected in Settings (ADR 022).
  const ownApp = useQuery(hobGitHubAppQuery(hob.id)).data;
  const bot = ownApp?._tag === "Connected" ? ownApp.bot : null;
  const connected = bot !== null || accountReady(github.data);
  const state = charmState(granted, ownApp, connected);

  return (
    <section
      aria-label={copy.card}
      className={cn(
        "flex flex-col rounded-card bg-card",
        granted
          ? "shadow-[inset_0_0_0_1px_var(--color-line),inset_0_3px_0_var(--color-mint-deep)]"
          : "shadow-[inset_0_0_0_1px_var(--color-line)]",
      )}
    >
      <div className="flex items-center gap-3.5 px-4.5 py-4">
        <CharmMark off={!granted} />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="flex flex-wrap items-center gap-2">
            <label htmlFor={switchId} className="text-[17px] leading-6 font-bold text-text-strong">
              {copy.name}
            </label>
            <Badge variant={STATE_BADGE[state]}>{copy.state[state]}</Badge>
          </span>
          <span className="text-detail text-text-secondary">
            {bot === null ? copy.reads({ name: hob.name }) : copy.readsAsBot({ name: hob.name, bot })}
          </span>
        </div>
        <Switch
          id={switchId}
          aria-label={copy.grant({ name: hob.name })}
          checked={granted}
          disabled={update.isPending}
          onCheckedChange={(on) => update.mutate({ githubCharm: on })}
        />
      </div>

      {granted ? (
        <div className="flex animate-hb-in flex-col gap-4.5 ps-16 pe-4.5 pb-4.5">
          <HobGitHubApp hob={hob} />
          <GitHubRules
            name={hob.name}
            permissions={permissions}
            sending={sending}
            pending={update.isPending || outdated}
            onPick={(overrides) => update.mutate({ overrides })}
          />
        </div>
      ) : (
        <span className="animate-hb-in ps-16 pe-4.5 pb-4 text-sm text-text-secondary">
          {copy.off({ name: hob.name })}
        </span>
      )}
      {!connected && (
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
      {update.isError && (
        <span role="alert" className="ps-16 pe-4.5 pb-4 text-detail text-rose">
          {copy.saveFailed}
        </span>
      )}
    </section>
  );
}

/** The Charm's mark before its name, faded while the Charm is off. */
const CharmMark = ({ off }: { off: boolean }) => (
  <span
    aria-hidden
    className={cn(
      "grid size-9 flex-none place-items-center rounded-control bg-text-strong font-heading text-[17px] font-bold text-ground",
      off && "opacity-55",
    )}
  >
    G
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

/** Allow, Ask or Never for each of the Charm's actions, saved at once as the hob's next version. */
function GitHubRules({
  name,
  permissions,
  sending,
  pending,
  onPick,
}: {
  name: string;
  permissions: HobPermissions;
  /** The change on its way to the hub. */
  sending: UpdateHobPermissionsPayload | undefined;
  pending: boolean;
  onPick: (overrides: PolicyOverrides) => void;
}) {
  const copy = messages.charms.github;
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-1.5">
      <h3 id={headingId} className="lbl m-0 text-label">
        {copy.mayDo({ name })}
      </h3>
      {GITHUB_RULES.map((rule) => (
        <Rule
          key={rule.operation}
          rule={rule}
          icon={ICONS[rule.operation]}
          permissions={permissions}
          shown={sending?.overrides ? shownAnswer(permissions, sending.overrides, rule.operation) : undefined}
          pending={pending}
          onPick={(answer) =>
            onPick(pickAnswer(permissions.policy.overrides, rule.operation, answer, permissions.preset))
          }
        />
      ))}
      <span className="text-detail text-label">{copy.rulesNote}</span>
    </section>
  );
}

// A mark for each action, before its name on the card.
const ICONS: Readonly<Record<string, string>> = {
  "read-github": "◇",
  push: "↑",
  "open-pull-request": "⇄",
  "comment-github": "✎",
};

/** The GitHub Charm's actions as its card names them, each with the hub's rule for it. */
const GITHUB_RULES: ReadonlyArray<RuleInfo> = GITHUB_OPERATIONS.map((operation) => {
  const rule = RULES.find((r) => r.operation === operation);
  const words = messages.charms.github.actions[operation];
  return { ...rule, operation, label: words.label, note: words.note };
});
