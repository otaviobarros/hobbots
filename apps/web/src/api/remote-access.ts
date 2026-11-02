import type { UpdateRemoteAccessPayload } from "@hobbots/api";
import type { RemoteAccessStatus } from "@hobbots/domain";
import { type QueryClient, queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { API_URL, call } from "./client.ts";

/** Remote access on the hub (ADR 021). The hub reports each change on the event stream. */
const remoteAccessKey = ["remote-access"] as const;

export const remoteAccessQuery = queryOptions({
  queryKey: remoteAccessKey,
  queryFn: () => call((c) => c.remoteAccess.get()),
});

export const useUpdateRemoteAccess = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: UpdateRemoteAccessPayload) => call((c) => c.remoteAccess.update({ payload })),
    onSuccess: (status) => queryClient.setQueryData(remoteAccessKey, status),
  });
};

/**
 * Where a page the hub serves itself reloads after the hub moved to `port`, or null when it stays:
 * the port did not change; the page has no port of its own, as over HTTPS through `tailscale serve`,
 * whose port stays; or the page calls the hub elsewhere, as the Vite dev server's and the desktop
 * app's windows do (the app moves its own windows).
 */
export const movedPage = (page: URL, apiUrl: string, port: number): string | null => {
  if (apiUrl !== page.origin || page.port === "" || page.port === String(port)) return null;
  const next = new URL(page.href);
  next.port = String(port);
  return next.href;
};

/** Takes a change the hub announced, and follows the hub to a new port. */
export const applyRemoteAccess = (queryClient: QueryClient, status: RemoteAccessStatus) => {
  queryClient.setQueryData(remoteAccessKey, status);
  if (globalThis.window?.hobbots !== undefined) return;
  const page = new URL(globalThis.location.href);
  const moved = movedPage(page, API_URL, status.port);
  if (moved !== null) globalThis.location.replace(moved);
};
