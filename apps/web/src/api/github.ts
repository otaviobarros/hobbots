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
  refetchOnWindowFocus: true,
  refetchInterval: (query) => (query.state.data?._tag === "Connecting" ? 2000 : false),
});

/** The sign-ins already on the hub. Reading them runs `gh` and `git` on the hub, so only when asked. */
export const githubFoundQuery = queryOptions({
  queryKey: [...githubStatusKey, "found"],
  queryFn: () => call((c) => c.github.found()),
  staleTime: 30_000,
});

/** What the connected account reaches; read again when the account changes. */
export const githubRepositoriesQuery = (login: string) =>
  queryOptions({
    queryKey: [...githubStatusKey, "repositories", login],
    queryFn: () => call((c) => c.github.repositories()),
    refetchOnWindowFocus: true,
  });

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
