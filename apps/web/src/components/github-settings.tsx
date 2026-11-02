import type { GitHubStatus } from "@hobbots/api";
import { GITHUB_APP_PERMISSIONS, type GitHubAccount } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { ApiError } from "../api/client.ts";
import {
  GITHUB_AUTHORIZED_APPS,
  githubFoundQuery,
  githubRepositoriesQuery,
  githubStatusQuery,
  REPOSITORY_WATCH,
  type RepositoryWatch,
  stillWatching,
  useGitHubChange,
} from "../api/github.ts";
import { formatDay } from "../lib/format.ts";
import { messages } from "./messages.ts";

const copy = messages.github;

type ConnectFailure = keyof typeof copy.connectFailed;

/** Why a change failed, in words, from the reason the hub gave. */
const changeError = (error: unknown): string => {
  const reason = error instanceof ApiError ? error.fields.reason : undefined;
  return typeof reason === "string" && reason in copy.connectFailed
    ? copy.connectFailed[reason as ConnectFailure]
    : copy.connectFailed.failed;
};

/**
 * Settings › Charms › GitHub (ADR 020): the account the GitHub Charm reaches GitHub as. You connect
 * it once, with the Hobbots GitHub App's device flow or a sign-in already on the hub, and see what
 * it reaches. No token ever reaches this page.
 */
export function GitHubSettings() {
  const status = useQuery(githubStatusQuery);
  const change = useGitHubChange();
  // Disconnecting from Hobbots leaves the app authorized on GitHub, which only GitHub can revoke.
  const [justDisconnected, setJustDisconnected] = useState(false);
  const run = (next: Parameters<typeof change.mutate>[0]) =>
    change.mutate(next, { onSuccess: () => setJustDisconnected(next.kind === "disconnect") });

  return (
    <div className="flex items-start gap-3.5 border-b-2 border-line py-2.5">
      <span aria-hidden className="cut grid size-[30px] flex-none place-items-center bg-line font-bold text-moonlight">
        GH
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <span className="font-bold">{copy.name}</span>
        {status.isError && (
          <p role="alert" className="m-0 flex flex-wrap items-center gap-3 text-sm text-rose">
            {copy.failed}
            <Button variant="outline" size="xs" onClick={() => void status.refetch()}>
              {copy.retry}
            </Button>
          </p>
        )}
        {status.data && (
          <GitHubState
            status={status.data}
            pending={change.isPending}
            onChange={run}
            justDisconnected={justDisconnected}
          />
        )}
        {change.isError && (
          <p role="alert" className="m-0 text-sm text-rose">
            {changeError(change.error)}
          </p>
        )}
      </div>
    </div>
  );
}

type Change = Parameters<ReturnType<typeof useGitHubChange>["mutate"]>[0];

function GitHubState({
  status,
  pending,
  onChange,
  justDisconnected,
}: {
  status: GitHubStatus;
  pending: boolean;
  onChange: (change: Change) => void;
  justDisconnected: boolean;
}) {
  switch (status._tag) {
    case "Environment":
      return <span className="text-[13px] text-secondary-text">{copy.environment}</span>;
    case "Connected":
      return (
        <Connected account={status.account} pending={pending} onDisconnect={() => onChange({ kind: "disconnect" })} />
      );
    case "Connecting":
      return <Connecting status={status} pending={pending} onCancel={() => onChange({ kind: "cancel" })} />;
    case "Disconnected":
      return <Disconnected status={status} pending={pending} onChange={onChange} justDisconnected={justDisconnected} />;
  }
}

function Connected({
  account,
  pending,
  onDisconnect,
}: {
  account: GitHubAccount;
  pending: boolean;
  onDisconnect: () => void;
}) {
  return (
    <>
      <span className="text-[13px] text-secondary-text">
        {copy.connectedAs({ login: account.login, since: formatDay(account.connectedAt) })}{" "}
        {copy.through[account.source]}
      </span>
      {account.source === "app" ? (
        <AppReach login={account.login} />
      ) : (
        <span className="text-[13px] text-label">{copy.everyRepository({ login: account.login })}</span>
      )}
      <div>
        <Button variant="outline" size="sm" disabled={pending} onClick={onDisconnect}>
          {copy.disconnect}
        </Button>
      </div>
    </>
  );
}

/** The repositories the app reaches, where to add more, and the permissions it holds there. */
function AppReach({ login }: { login: string }) {
  // After the person goes to GitHub to choose repositories, the list is read again every few
  // seconds until it changes, so it updates even with both windows side by side.
  const [watch, setWatch] = useState<RepositoryWatch | null>(null);
  const repositories = useQuery(githubRepositoriesQuery(login, watch !== null));
  const listed = repositories.data?.repositories;
  const names = listed?.map((repository) => repository.fullName).join("\n") ?? "";
  useEffect(() => {
    if (watch === null) return;
    if (!stillWatching(watch, names, Date.now())) {
      setWatch(null);
      return;
    }
    const timer = setTimeout(() => setWatch(null), watch.until - Date.now());
    return () => clearTimeout(timer);
  }, [watch, names]);
  const queryClient = useQueryClient();
  // A listing GitHub refused may mean the hub disconnected, so the connection is read again.
  useEffect(() => {
    if (repositories.isError) void queryClient.invalidateQueries({ queryKey: githubStatusQuery.queryKey });
  }, [repositories.isError, queryClient]);
  return (
    <>
      <span className="lbl pt-1 text-xs text-label">{copy.repositoriesLabel}</span>
      {repositories.isError && <span className="text-[13px] text-rose">{copy.repositoriesFailed}</span>}
      {listed && listed.length === 0 && <span className="text-[13px] text-secondary-text">{copy.noRepositories}</span>}
      {listed && listed.length > 0 && (
        <ul aria-label={copy.repositoriesLabel} className="m-0 flex list-none flex-wrap gap-1.5 p-0">
          {listed.map((repository) => (
            <li key={repository.fullName} className="bg-line px-2 py-0.5 text-[13px]">
              {repository.fullName}
              {repository.private && <span className="ms-1.5 text-label">{copy.private}</span>}
            </li>
          ))}
        </ul>
      )}
      {repositories.data && (
        <a
          href={repositories.data.installUrl}
          target="_blank"
          rel="noreferrer"
          onClick={() => setWatch({ until: Date.now() + REPOSITORY_WATCH.forMs, seen: names })}
          className="text-[13px] text-lantern no-underline hover:underline"
        >
          {copy.chooseRepositories}
        </a>
      )}
      <span className="lbl pt-1 text-xs text-label">{copy.permissionsLabel}</span>
      <ul aria-label={copy.permissionsLabel} className="m-0 flex list-none flex-wrap gap-1.5 p-0">
        {GITHUB_APP_PERMISSIONS.map((permission) => (
          <li key={permission.name} className="border-2 border-line px-2 py-0.5 text-[13px] text-secondary-text">
            {copy.permission(permission)}
          </li>
        ))}
      </ul>
    </>
  );
}

function Connecting({
  status,
  pending,
  onCancel,
}: {
  status: Extract<GitHubStatus, { _tag: "Connecting" }>;
  pending: boolean;
  onCancel: () => void;
}) {
  return (
    <div className="cut flex flex-col gap-2 border-2 border-lantern bg-notice px-3 py-2.5" role="status">
      <span className="text-sm">{copy.enterCode}</span>
      <span className="select-all font-pixel text-[28px] font-bold tracking-widest text-moonlight">
        {status.userCode}
      </span>
      <span className="text-[13px] text-secondary-text">{copy.waiting}</span>
      <div className="flex flex-wrap gap-2">
        <Button asChild size="sm">
          <a href={status.verificationUri} target="_blank" rel="noreferrer">
            {copy.openGitHub}
          </a>
        </Button>
        <Button variant="outline" size="sm" disabled={pending} onClick={onCancel}>
          {copy.cancel}
        </Button>
      </div>
    </div>
  );
}

function Disconnected({
  status,
  pending,
  onChange,
  justDisconnected,
}: {
  status: Extract<GitHubStatus, { _tag: "Disconnected" }>;
  pending: boolean;
  onChange: (change: Change) => void;
  justDisconnected: boolean;
}) {
  const found = useQuery(githubFoundQuery);
  return (
    <>
      {justDisconnected && (
        <span className="text-[13px] text-secondary-text">
          {copy.disconnected}{" "}
          <a href={GITHUB_AUTHORIZED_APPS} target="_blank" rel="noreferrer" className="text-lantern">
            {copy.authorizedApps}
          </a>
        </span>
      )}
      {status.problem && (
        <span role="alert" className="text-[13px] text-rose">
          {copy.problem[status.problem.reason]}
        </span>
      )}
      {status.cannotConnect === null ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button size="sm" disabled={pending} onClick={() => onChange({ kind: "connect" })}>
            {copy.connect}
          </Button>
          <span className="text-[13px] text-label">{copy.recommended}</span>
        </div>
      ) : (
        <span className="text-[13px] text-secondary-text">{copy.cannotConnect[status.cannotConnect]}</span>
      )}
      {found.data && found.data.length > 0 && (
        <>
          <span className="lbl pt-1 text-xs text-label">{copy.found}</span>
          <ul aria-label={copy.found} className="m-0 flex list-none flex-col gap-1.5 p-0">
            {found.data.map((signIn) => (
              <li key={signIn.source} className="flex flex-wrap items-center gap-3">
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="text-sm">{copy.foundSource[signIn.source]({ login: signIn.login })}</span>
                  <span className="text-[13px] text-label">{copy.foundNote}</span>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={pending}
                  onClick={() => onChange({ kind: "use", source: signIn.source })}
                >
                  {copy.use}
                </Button>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}
