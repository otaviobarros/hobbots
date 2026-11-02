import type { UpdateRemoteAccessPayload } from "@hobbots/api";
import { httpsAddress, type RemoteAccessStatus } from "@hobbots/domain";
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
    // A new port moves this page at once when the hub serves it, before the event arrives.
    onSuccess: (status) => applyRemoteAccess(queryClient, status),
  });
};

/**
 * Runs `tailscale serve` on the hub after the user consented (ADR 021): `forward` serves the hub
 * over HTTPS on its MagicDNS name, and false removes that.
 */
export const useServe = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (forward: boolean) => call((c) => c.remoteAccess.serve({ payload: { forward } })),
    onSuccess: (status) => queryClient.setQueryData(remoteAccessKey, status),
  });
};

/**
 * Where a page on the tailnet's plain HTTP address goes once Tailscale serves the hub over HTTPS:
 * the same path on the HTTPS address. Null for any other page, such as one on this computer.
 */
export const securePage = (page: URL, apiUrl: string, status: RemoteAccessStatus): string | null => {
  const address = httpsAddress(status);
  if (address === null || apiUrl !== page.origin || page.protocol !== "http:") return null;
  if (page.hostname !== status.tailscale?.dnsName) return null;
  return `${address}${page.pathname}${page.search}${page.hash}`;
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

/** Takes a change the hub announced, and follows the hub to a new port or to its HTTPS address. */
export const applyRemoteAccess = (queryClient: QueryClient, status: RemoteAccessStatus) => {
  queryClient.setQueryData(remoteAccessKey, status);
  if (globalThis.window?.hobbots !== undefined) return;
  const page = new URL(globalThis.location.href);
  const moved = securePage(page, API_URL, status) ?? movedPage(page, API_URL, status.port);
  if (moved !== null) globalThis.location.replace(moved);
};
