import type { GitHubStatus } from "@hobbots/api";
import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { call } from "./client.ts";

/**
 * The GitHub account the hub connects for the GitHub Charm (ADR 020). While a code is showing, the
 * status is read every two seconds, so the page moves on once the person enters it on GitHub.
 */
const githubStatusKey = ["charms", "github"] as const;

export const githubStatusQuery = queryOptions({
  queryKey: githubStatusKey,
  queryFn: () => call((c) => c.github.status()),
  // The person connects and installs on GitHub, then comes back: ask again every time.
  staleTime: 0,
  refetchOnWindowFocus: true,
  refetchInterval: (query) => (query.state.data?._tag === "Connecting" ? 2000 : false),
});

/** The sign-ins already on the hub. Reading them runs `gh` and `git` on the hub, so only when asked. */
export const githubFoundQuery = queryOptions({
  queryKey: [...githubStatusKey, "found"],
  queryFn: () => call((c) => c.github.found()),
  staleTime: 30_000,
});

/** How long, and how often, the list is read again after the person goes to choose repositories. */
export const REPOSITORY_WATCH = { forMs: 3 * 60_000, everyMs: 5_000 } as const;

/**
 * What the connected account reaches. GitHub cannot tell a hub without a public address that it
 * changed, so it is read again whenever the window comes back, and every few seconds while
 * `watching`, after the person went to GitHub to choose repositories.
 */
export const githubRepositoriesQuery = (login: string, watching = false) =>
  queryOptions({
    queryKey: [...githubStatusKey, "repositories", login],
    queryFn: () => call((c) => c.github.repositories()),
    staleTime: 0,
    refetchOnWindowFocus: true,
    refetchInterval: watching ? REPOSITORY_WATCH.everyMs : false,
  });

/** A watch on the repository list, started when the person goes to choose repositories. */
export interface RepositoryWatch {
  readonly until: number;
  /** The list as it was when the watch started. */
  readonly seen: string;
}

/** Whether to keep reading the list: until it changes, or the watch runs out. */
export const stillWatching = (watch: RepositoryWatch | null, list: string, now: number): boolean =>
  watch !== null && list === watch.seen && now < watch.until;

/** Every change answers with the new status, which replaces the one shown. */
export const useGitHubChange = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (
      change:
        | { readonly kind: "connect" | "cancel" | "disconnect" }
        | { readonly kind: "use"; readonly source: "gh" | "git" },
    ): Promise<GitHubStatus> =>
      change.kind === "use"
        ? call((c) => c.github.use({ payload: { source: change.source } }))
        : call((c) => c.github[change.kind]()),
    onSuccess: (status) => queryClient.setQueryData(githubStatusKey, status),
  });
};

/** Where GitHub lists the apps the person authorized, to revoke Hobbots there. */
export const GITHUB_AUTHORIZED_APPS = "https://github.com/settings/apps/authorizations";
