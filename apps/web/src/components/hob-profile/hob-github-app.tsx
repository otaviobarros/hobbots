import type { HobGitHubAppDisconnected, HobGitHubAppStarted, HobGitHubAppStatus } from "@hobbots/api";
import { HOB_COLORS } from "@hobbots/art/look";
import { type Agent, hobAppBot } from "@hobbots/domain";
import { Badge } from "@hobbots/ui/components/badge";
import { Button } from "@hobbots/ui/components/button";
import { Skeleton } from "@hobbots/ui/components/skeleton";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { ApiError } from "../../api/client.ts";
import { githubStatusQuery } from "../../api/github.ts";
import {
  HOB_APP_WATCH,
  hobGitHubAppQuery,
  useDisconnectHobGitHubApp,
  useHobGitHubAppInstallations,
  useStartHobGitHubApp,
} from "../../api/hob-github-app.ts";
import { formatDay } from "../../lib/format.ts";
import { HobSprite } from "../hob-sprite/hob-sprite.tsx";
import { messages } from "../messages.ts";

const copy = messages.charms.github.app;

type Started = HobGitHubAppStarted;

type Connected = Extract<HobGitHubAppStatus, { _tag: "Connected" }>;

/** The hub's own words for a refusal, such as starting from another device, or a plain fallback. */
const refusalOf = (error: unknown, fallback: string): string =>
  error instanceof ApiError && typeof error.fields.message === "string" ? error.fields.message : fallback;

/** Keeps reading the hob's app for a while after the user goes to GitHub. Answers whether, and how to start. */
const useWatch = () => {
  const [until, setUntil] = useState<number | null>(null);
  useEffect(() => {
    if (until === null) return;
    const timer = setTimeout(() => setUntil(null), Math.max(0, until - Date.now()));
    return () => clearTimeout(timer);
  }, [until]);
  return [until !== null, () => setUntil(Date.now() + HOB_APP_WATCH.forMs)] as const;
};

/** Opens a page in the user's default browser: a new tab here, or the system browser from the desktop app. */
const openInBrowser = (url: string) => {
  window.open(url, "_blank", "noopener,noreferrer");
};

/**
 * Who the hob acts as on GitHub (ADR 022): you, by default, or its own GitHub App, made from a
 * manifest on GitHub. Shows where the app is installed, what needs fixing, and disconnects it. No key
 * or token ever reaches this page.
 */
export function HobGitHubApp({ hob }: { hob: Agent }) {
  // Set while the user is on GitHub making the app: the hub page that takes them there, until it expires.
  const [started, setStarted] = useState<Started | null>(null);
  const [expired, setExpired] = useState(false);
  const [disconnected, setDisconnected] = useState<HobGitHubAppDisconnected | null>(null);
  const [watching, watch] = useWatch();
  const status = useQuery(hobGitHubAppQuery(hob.id, watching));
  const start = useStartHobGitHubApp(hob.id);
  const disconnect = useDisconnectHobGitHubApp(hob.id);
  const tag = status.data?._tag;
  // Once the app is made, there is nothing left to finish on GitHub.
  useEffect(() => {
    if (tag === "Connected") setStarted(null);
  }, [tag]);
  // The hub's page answers for an hour at most; after that only a new start can make the app.
  useEffect(() => {
    if (started === null) return;
    const timer = setTimeout(
      () => {
        setStarted(null);
        setExpired(true);
      },
      Math.max(0, Date.parse(started.expiresAt) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [started]);

  const begin = () =>
    start.mutate(undefined, {
      onSuccess: (opened) => {
        setStarted(opened);
        setExpired(false);
        watch();
        openInBrowser(opened.url);
      },
    });
  // A new app replaces one GitHub no longer accepts: the old one is removed, dismissed if anything of
  // it is left, and the new one started, in one action.
  const replace = () =>
    disconnect.mutate(undefined, {
      onSuccess: (gone) => {
        const dismiss = gone.problem === null ? Promise.resolve(gone) : disconnect.mutateAsync();
        void dismiss.then((last) => {
          setDisconnected({ deleteUrl: gone.deleteUrl ?? last.deleteUrl, problem: null });
          begin();
        });
      },
    });

  return (
    <section aria-label={copy.label} className="flex flex-col gap-2.5">
      <h3 className="lbl m-0 flex items-center gap-2 text-label after:h-px after:flex-1 after:bg-line after:content-['']">
        {copy.label}
      </h3>
      {status.isError && (
        <p role="alert" className="m-0 flex flex-wrap items-center gap-3 text-detail text-rose">
          {copy.failed}
          <Button variant="outline" size="xs" onClick={() => void status.refetch()}>
            {copy.retry}
          </Button>
        </p>
      )}
      {status.isPending && <WhoWaiting />}
      {status.data?._tag === "None" && (
        <NoApp
          hob={hob}
          cannotCreate={status.data.cannotCreate}
          started={started}
          expired={expired}
          pending={start.isPending}
          onGive={() => {
            setDisconnected(null);
            begin();
          }}
          onCancel={() => setStarted(null)}
        />
      )}
      {status.data?._tag === "Connected" && (
        <ConnectedApp
          hob={hob}
          status={status.data}
          pending={disconnect.isPending || start.isPending}
          onWatch={watch}
          watching={watching}
          onNewApp={replace}
          onDisconnect={() => disconnect.mutate(undefined, { onSuccess: setDisconnected })}
        />
      )}
      {status.data?._tag === "LeftOver" && (
        <LeftOver
          hob={hob}
          status={status.data}
          pending={disconnect.isPending}
          onDismiss={() => disconnect.mutate(undefined, { onSuccess: () => setDisconnected(null) })}
        />
      )}
      <Outcome
        hob={hob}
        disconnected={status.data?._tag === "None" ? disconnected : null}
        startError={start.isError ? start.error : null}
        changeFailed={disconnect.isError}
      />
    </section>
  );
}

// The card finishes of the design: a lantern-tinted offer, a quiet wait, and a rose-tinted problem.
const OFFER =
  "flex flex-wrap items-center gap-3.5 rounded-control bg-[color-mix(in_srgb,var(--color-lantern)_9%,var(--color-deep))] px-4 py-3.5 shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-lantern)_35%,transparent)]";
const WAIT = "flex flex-col gap-2.5 rounded-control bg-deep px-4 py-3.5 shadow-[inset_0_0_0_1px_var(--color-line-2)]";
const PROBLEM =
  "flex flex-col items-start gap-2 rounded-control bg-[color-mix(in_srgb,var(--color-rose)_10%,var(--color-deep))] px-4 py-3.5 shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-rose)_40%,transparent)]";

/** What the last change did: a disconnect with where to delete the app, or why a change failed. */
function Outcome({
  hob,
  disconnected,
  startError,
  changeFailed,
}: {
  hob: Agent;
  disconnected: HobGitHubAppDisconnected | null;
  startError: unknown;
  changeFailed: boolean;
}) {
  return (
    <>
      {disconnected !== null && (
        <span role="status" className="rounded-control bg-notice px-3 py-2 text-detail text-text">
          {copy.disconnected({ name: hob.name })}
          {disconnected.deleteUrl !== null && (
            <>
              {" "}
              <a href={disconnected.deleteUrl} target="_blank" rel="noreferrer" className="text-link underline">
                {copy.deleteOnGitHub}
              </a>
            </>
          )}
        </span>
      )}
      {startError !== null && (
        <span role="alert" className="text-detail text-rose">
          {refusalOf(startError, copy.startFailed)}
        </span>
      )}
      {changeFailed && (
        <span role="alert" className="text-detail text-rose">
          {copy.changeFailed}
        </span>
      )}
    </>
  );
}

/**
 * While the user is on GitHub: the hub page again, for a tab closed too soon, or a fresh start, for a
 * page GitHub sent back with an error or one that already ran out, since each page works only once.
 */
function Finishing({
  hob,
  started,
  pending,
  onRestart,
  onCancel,
}: {
  hob: Agent;
  started: Started;
  pending: boolean;
  onRestart: () => void;
  onCancel: () => void;
}) {
  return (
    <div className={WAIT} role="status">
      <span className="flex items-center gap-2.5">
        <span
          aria-hidden
          className="size-3.5 flex-none animate-hb-spin rounded-dot border-(length:--edge) border-lantern/30 border-t-lantern motion-reduce:animate-none"
        />
        <strong className="text-ui text-text-strong">{copy.finishOnGitHub({ name: hob.name })}</strong>
      </span>
      <span className="text-detail text-text-secondary">{copy.restartNote}</span>
      <span className="flex flex-wrap items-center gap-2">
        <Button asChild variant="outline" size="sm">
          <a href={started.url} target="_blank" rel="noreferrer">
            {copy.openAgain}
          </a>
        </Button>
        <Button variant="ghost" size="sm" disabled={pending} onClick={onRestart}>
          {copy.restart}
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          {copy.cancel}
        </Button>
      </span>
    </div>
  );
}

/** Who the hob acts as when it has no app of its own: you, with the account connected in Settings. */
function You({ hob }: { hob: Agent }) {
  const github = useQuery(githubStatusQuery).data;
  const login = github?._tag === "Connected" ? github.account.login : null;
  return (
    <div className="flex items-center gap-3">
      <span
        aria-hidden
        className="grid size-9 flex-none place-items-center rounded-dot bg-[color-mix(in_srgb,var(--color-moonlight)_26%,var(--color-deep))] font-bold text-text-strong"
      >
        {(login ?? "?").slice(0, 1).toUpperCase()}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <strong className="text-text-strong">{login === null ? copy.you : copy.youAs({ login })}</strong>
        <span className="text-detail text-text-secondary">{copy.asYou({ name: hob.name })}</span>
      </span>
    </div>
  );
}

/** Who the hob acts as, while the hub asks: a tile and two line blocks in the place of You. */
const WhoWaiting = () => (
  <div className="flex items-center gap-3">
    <Skeleton shape="dot" surface="card" className="size-9" />
    <span className="flex min-w-0 flex-1 flex-col">
      <Skeleton surface="card" width="12ch" />
      <span className="text-detail">
        <Skeleton surface="card" width="36ch" />
      </span>
    </span>
  </div>
);

function NoApp({
  hob,
  cannotCreate,
  started,
  expired,
  pending,
  onGive,
  onCancel,
}: {
  hob: Agent;
  cannotCreate: "no-keychain" | null;
  started: Started | null;
  expired: boolean;
  pending: boolean;
  onGive: () => void;
  onCancel: () => void;
}) {
  return (
    <>
      {started === null && <You hob={hob} />}
      {cannotCreate === "no-keychain" && <span className="text-detail text-label">{copy.noKeychain}</span>}
      {cannotCreate === null && hob.status !== "retired" && started === null && (
        <div className={OFFER}>
          <span className="flex min-w-[220px] flex-1 flex-col">
            <strong className="text-ui text-text-strong">{copy.give({ name: hob.name })}</strong>
            <span className="text-detail text-text-secondary">{copy.giveNote({ name: hob.name })}</span>
            {expired && <span className="text-detail text-label">{copy.expired}</span>}
          </span>
          <Button disabled={pending} onClick={onGive}>
            {copy.makeApp}
          </Button>
        </div>
      )}
      {started !== null && (
        <Finishing hob={hob} started={started} pending={pending} onRestart={onGive} onCancel={onCancel} />
      )}
    </>
  );
}

function ConnectedApp({
  hob,
  status,
  pending,
  watching,
  onWatch,
  onNewApp,
  onDisconnect,
}: {
  hob: Agent;
  status: Connected;
  pending: boolean;
  watching: boolean;
  onWatch: () => void;
  onNewApp: () => void;
  onDisconnect: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const { app, needsReconnect } = status;
  return (
    <>
      <div className="flex items-center gap-3">
        <span
          aria-hidden
          className="grid size-10 flex-none place-items-end overflow-hidden rounded-control"
          style={{
            background: `linear-gradient(180deg, color-mix(in srgb, ${HOB_COLORS[hob.lookColor].hat} 30%, var(--color-deep)), color-mix(in srgb, ${HOB_COLORS[hob.lookColor].hat} 12%, var(--color-deep)))`,
          }}
        >
          <HobSprite hob={hob} size={34} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex flex-wrap items-center gap-2">
            <a
              href={app.htmlUrl}
              target="_blank"
              rel="noreferrer"
              className="font-mono text-ui font-bold text-text-strong no-underline hover:underline hover:decoration-lantern"
            >
              {hobAppBot(app)}
            </a>
            <Badge variant="waiting">{copy.ownApp}</Badge>
          </span>
          <span className="text-detail text-text-secondary">{copy.made({ since: formatDay(app.connectedAt) })}</span>
        </span>
      </div>
      {needsReconnect !== null && (
        <div role="alert" className={PROBLEM}>
          <span className="flex items-center gap-2">
            <strong className="text-text-strong">{copy.reconnectTitle}</strong>
            <Badge variant="failed">{copy.cannotAct}</Badge>
          </span>
          <span className="text-ui text-text">
            {needsReconnect.reason === "key"
              ? copy.reconnectKey({ name: hob.name })
              : copy.reconnectInstallation({ name: hob.name })}
          </span>
          {needsReconnect.reason === "key" ? (
            <Button disabled={pending} onClick={onNewApp}>
              {copy.newApp({ name: hob.name })}
            </Button>
          ) : (
            <Button asChild>
              <a href={status.installUrl} target="_blank" rel="noreferrer" onClick={onWatch}>
                {copy.reinstall}
              </a>
            </Button>
          )}
        </div>
      )}
      {needsReconnect?.reason !== "key" && (
        <Installations hob={hob} status={status} watching={watching} onWatch={onWatch} />
      )}
      {confirming ? (
        <div className={PROBLEM}>
          <span className="text-ui text-text">{copy.confirmDisconnect({ name: hob.name })}</span>
          <span className="flex flex-wrap gap-2">
            <Button variant="deny" disabled={pending} onClick={onDisconnect}>
              {copy.disconnect}
            </Button>
            <Button variant="outline" onClick={() => setConfirming(false)}>
              {copy.keep}
            </Button>
          </span>
        </div>
      ) : (
        <Button variant="ghost" size="sm" className="self-start" disabled={pending} onClick={() => setConfirming(true)}>
          {copy.disconnectAsk}
        </Button>
      )}
    </>
  );
}

/** Where the hob's app is installed, with where to change each, or a prompt to install it. */
function Installations({
  hob,
  status,
  watching,
  onWatch,
}: {
  hob: Agent;
  status: Connected;
  watching: boolean;
  onWatch: () => void;
}) {
  const installations = useHobGitHubAppInstallations(hob.id, status.app.appId, watching);
  const listed = installations.data?.installations;
  if (installations.isError) {
    return (
      <p role="alert" className="m-0 flex flex-wrap items-center gap-3 text-detail text-rose">
        {copy.installationsFailed}
        <Button variant="outline" size="xs" onClick={() => void installations.refetch()}>
          {copy.retry}
        </Button>
      </p>
    );
  }
  if (listed === undefined) return null;
  if (listed.length === 0) {
    return (
      <div className={OFFER}>
        <span className="flex min-w-[220px] flex-1 flex-col">
          <strong className="text-ui text-text-strong">{copy.installTitle}</strong>
          <span className="text-detail text-text-secondary">{copy.notInstalled({ name: hob.name })}</span>
        </span>
        <Button asChild>
          <a href={status.installUrl} target="_blank" rel="noreferrer" onClick={onWatch}>
            {copy.install}
          </a>
        </Button>
      </div>
    );
  }
  return (
    <ul
      aria-label={copy.installedLabel}
      className="m-0 flex list-none flex-col gap-2 rounded-control bg-deep px-3.5 py-3 p-0"
    >
      {listed.map((installation) => (
        <li key={installation.id} className="flex flex-col gap-2 px-3.5 py-1 first:pt-3 last:pb-3">
          <span className="flex flex-wrap items-center gap-2 text-ui">
            <span className="flex-1">
              {copy.installation({ account: installation.account, all: installation.repositorySelection === "all" })}
              {installation.suspended && <span className="ms-1.5 text-rose">{copy.suspended}</span>}
            </span>
            <a
              href={installation.htmlUrl}
              target="_blank"
              rel="noreferrer"
              onClick={onWatch}
              className="text-detail text-link underline"
            >
              {copy.change}
            </a>
          </span>
          {installation.repositories !== null && (
            <Repositories account={installation.account} names={installation.repositories} />
          )}
        </li>
      ))}
    </ul>
  );
}

/** At most this many repositories are named for one installation; the rest are counted. */
const NAMED_REPOSITORIES = 8;

/** The repositories one installation reaches, by name, without the account when it is the installation's. */
function Repositories({ account, names }: { account: string; names: ReadonlyArray<string> }) {
  if (names.length === 0) {
    return <span className="text-meta text-text-secondary">{copy.noRepositories}</span>;
  }
  const shown = names.slice(0, NAMED_REPOSITORIES);
  const chip =
    "rounded-tag bg-card px-2 py-0.5 font-mono text-meta text-text-secondary shadow-[inset_0_0_0_1px_var(--color-line)]";
  return (
    <ul aria-label={copy.reaches({ account })} className="m-0 flex list-none flex-wrap gap-1.5 p-0">
      {shown.map((name) => (
        <li key={name} className={chip}>
          {name.startsWith(`${account}/`) ? name.slice(account.length + 1) : name}
        </li>
      ))}
      {names.length > shown.length && (
        <li className="px-1 text-meta text-text-secondary">
          {copy.moreRepositories({ count: names.length - shown.length })}
        </li>
      )}
    </ul>
  );
}

function LeftOver({
  hob,
  status,
  pending,
  onDismiss,
}: {
  hob: Agent;
  status: Extract<HobGitHubAppStatus, { _tag: "LeftOver" }>;
  pending: boolean;
  onDismiss: () => void;
}) {
  return (
    <div role="alert" className={PROBLEM}>
      <strong className="text-text-strong">{copy.leftOverTitle({ name: hob.name })}</strong>
      <span className="text-ui text-text">
        {copy.leftOver} {status.problem}
      </span>
      <span className="flex flex-wrap items-center gap-3">
        <Button asChild variant="outline">
          <a href={status.deleteUrl} target="_blank" rel="noreferrer">
            {copy.deleteOnGitHub}
          </a>
        </Button>
        <Button variant="ghost" disabled={pending} onClick={onDismiss}>
          {copy.dismiss}
        </Button>
      </span>
    </div>
  );
}
