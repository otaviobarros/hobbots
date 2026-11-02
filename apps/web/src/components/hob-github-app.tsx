import type { HobGitHubAppDisconnected, HobGitHubAppStarted, HobGitHubAppStatus } from "@hobbots/api";
import { type Agent, hobAppBot } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { ApiError } from "../api/client.ts";
import {
  HOB_APP_WATCH,
  hobGitHubAppQuery,
  useDisconnectHobGitHubApp,
  useHobGitHubAppInstallations,
  useStartHobGitHubApp,
} from "../api/hob-github-app.ts";
import { formatDay } from "../lib/format.ts";
import { messages } from "./messages.ts";

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
    <section aria-label={copy.label} className="flex flex-col gap-2 border-t-2 border-line pt-2.5 ps-[54px]">
      <h3 className="lbl m-0 text-xs text-label">{copy.label}</h3>
      {status.isError && (
        <p role="alert" className="m-0 flex flex-wrap items-center gap-3 text-[13px] text-rose">
          {copy.failed}
          <Button variant="outline" size="xs" onClick={() => void status.refetch()}>
            {copy.retry}
          </Button>
        </p>
      )}
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
        <span role="status" className="text-[13px] text-secondary-text">
          {copy.disconnected({ name: hob.name })}
          {disconnected.deleteUrl !== null && (
            <>
              {" "}
              <a href={disconnected.deleteUrl} target="_blank" rel="noreferrer" className="text-lantern">
                {copy.deleteOnGitHub}
              </a>
            </>
          )}
        </span>
      )}
      {startError !== null && (
        <span role="alert" className="text-[13px] text-rose">
          {refusalOf(startError, copy.startFailed)}
        </span>
      )}
      {changeFailed && (
        <span role="alert" className="text-[13px] text-rose">
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
    <div className="cut flex flex-col gap-1.5 border-2 border-lantern bg-notice px-3 py-2.5" role="status">
      <span className="text-[13px]">{copy.finishOnGitHub({ name: hob.name })}</span>
      <a href={started.url} target="_blank" rel="noreferrer" className="text-[13px] text-lantern">
        {copy.openAgain}
      </a>
      <span className="text-[13px] text-secondary-text">{copy.restartNote}</span>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" disabled={pending} onClick={onRestart}>
          {copy.restart}
        </Button>
        <Button variant="outline" size="sm" onClick={onCancel}>
          {copy.cancel}
        </Button>
      </div>
    </div>
  );
}

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
      <span className="text-[13px] text-secondary-text">{copy.asYou({ name: hob.name })}</span>
      {cannotCreate === "no-keychain" && <span className="text-[13px] text-label">{copy.noKeychain}</span>}
      {cannotCreate === null && hob.status !== "retired" && started === null && (
        <div className="flex flex-col items-start gap-1.5">
          <Button size="sm" disabled={pending} onClick={onGive}>
            {copy.give({ name: hob.name })}
          </Button>
          <span className="text-[13px] text-label">{copy.giveNote({ name: hob.name })}</span>
          {expired && <span className="text-[13px] text-label">{copy.expired}</span>}
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
      <span className="text-[13px] text-secondary-text">
        {copy.actsAs}{" "}
        <a href={app.htmlUrl} target="_blank" rel="noreferrer" className="font-bold text-moonlight">
          {hobAppBot(app)}
        </a>
        . {copy.since({ since: formatDay(app.connectedAt) })}
      </span>
      {needsReconnect !== null && (
        <div role="alert" className="cut flex flex-col items-start gap-2 border-2 border-rose bg-notice px-3 py-2.5">
          <span className="text-sm font-bold text-rose">{copy.reconnectTitle}</span>
          <span className="text-[13px]">
            {needsReconnect.reason === "key"
              ? copy.reconnectKey({ name: hob.name })
              : copy.reconnectInstallation({ name: hob.name })}
          </span>
          {needsReconnect.reason === "key" ? (
            <Button size="sm" disabled={pending} onClick={onNewApp}>
              {copy.newApp({ name: hob.name })}
            </Button>
          ) : (
            <Button asChild size="sm">
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
        <div className="flex flex-col items-start gap-2">
          <span className="text-[13px]">{copy.confirmDisconnect({ name: hob.name })}</span>
          <div className="flex flex-wrap gap-2">
            <Button variant="deny" size="sm" disabled={pending} onClick={onDisconnect}>
              {copy.disconnect}
            </Button>
            <Button variant="outline" size="sm" onClick={() => setConfirming(false)}>
              {copy.cancel}
            </Button>
          </div>
        </div>
      ) : (
        <div>
          <Button variant="outline" size="sm" disabled={pending} onClick={() => setConfirming(true)}>
            {copy.disconnect}
          </Button>
        </div>
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
      <p role="alert" className="m-0 flex flex-wrap items-center gap-3 text-[13px] text-rose">
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
      <div className="flex flex-col items-start gap-1.5">
        <span className="text-[13px] text-secondary-text">{copy.notInstalled({ name: hob.name })}</span>
        <Button asChild size="sm">
          <a href={status.installUrl} target="_blank" rel="noreferrer" onClick={onWatch}>
            {copy.install}
          </a>
        </Button>
      </div>
    );
  }
  return (
    <>
      <span className="lbl pt-1 text-xs text-label">{copy.installedLabel}</span>
      <ul aria-label={copy.installedLabel} className="m-0 flex list-none flex-col gap-1.5 p-0">
        {listed.map((installation) => (
          <li key={installation.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px]">
            <span>
              {copy.installation({ account: installation.account, all: installation.repositorySelection === "all" })}
              {installation.suspended && <span className="ms-1.5 text-rose">{copy.suspended}</span>}
            </span>
            <a
              href={installation.htmlUrl}
              target="_blank"
              rel="noreferrer"
              onClick={onWatch}
              className="text-lantern no-underline hover:underline"
            >
              {copy.change}
            </a>
            {installation.repositories !== null && (
              <Repositories account={installation.account} names={installation.repositories} />
            )}
          </li>
        ))}
      </ul>
    </>
  );
}

/** At most this many repositories are named for one installation; the rest are counted. */
const NAMED_REPOSITORIES = 8;

/** The repositories one installation reaches, by name, without the account when it is the installation's. */
function Repositories({ account, names }: { account: string; names: ReadonlyArray<string> }) {
  if (names.length === 0) {
    return <span className="basis-full text-xs text-secondary-text">{copy.noRepositories}</span>;
  }
  const shown = names.slice(0, NAMED_REPOSITORIES);
  return (
    <ul
      aria-label={copy.reaches({ account })}
      className="m-0 flex basis-full list-none flex-wrap gap-x-2.5 gap-y-1 p-0 font-mono text-xs text-secondary-text"
    >
      {shown.map((name) => (
        <li key={name}>{name.startsWith(`${account}/`) ? name.slice(account.length + 1) : name}</li>
      ))}
      {names.length > shown.length && <li>{copy.moreRepositories({ count: names.length - shown.length })}</li>}
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
    <div role="alert" className="cut flex flex-col items-start gap-2 border-2 border-rose bg-notice px-3 py-2.5">
      <span className="text-[13px]">
        {copy.leftOver({ name: hob.name })} {status.problem}
      </span>
      <div className="flex flex-wrap items-center gap-3">
        <a href={status.deleteUrl} target="_blank" rel="noreferrer" className="text-[13px] text-lantern">
          {copy.deleteOnGitHub}
        </a>
        <Button variant="outline" size="sm" disabled={pending} onClick={onDismiss}>
          {copy.dismiss}
        </Button>
      </div>
    </div>
  );
}
