import { type QueryClient, queryOptions, useQuery } from "@tanstack/react-query";
import { ApiError, call } from "./client.ts";

/**
 * Marks a query that holds what only this client knows. A resync with the hub fetches every other
 * query again, but refetching one of these would only reset it.
 */
const LOCAL = { local: true } as const;

/** Whether this client hears the hub's live events right now. */
export type ConnectionState = "connecting" | "live" | "reconnecting";

const connectionKey = ["connection"] as const;

export const connectionQuery = queryOptions({
  queryKey: connectionKey,
  queryFn: (): ConnectionState => "connecting",
  meta: LOCAL,
  staleTime: Number.POSITIVE_INFINITY,
  gcTime: Number.POSITIVE_INFINITY,
});

export const setConnection = (queryClient: QueryClient, state: ConnectionState) =>
  queryClient.setQueryData<ConnectionState>(connectionKey, state);

export const useConnection = (): ConnectionState => useQuery(connectionQuery).data ?? "connecting";

/**
 * Whether this device may still use the hub (ADR 021). `removed`: the hub answered that this device
 * was revoked. `unreachable`: the hub did not answer at all, as when it is off or remote access is
 * paused. Only the hub's own answers set it, never a guess.
 */
export type DeviceAccess = "approved" | "removed" | "unreachable";

const accessKey = ["device-access"] as const;

const deviceAccessQuery = queryOptions({
  queryKey: accessKey,
  queryFn: (): DeviceAccess => "approved",
  meta: LOCAL,
  staleTime: Number.POSITIVE_INFINITY,
  gcTime: Number.POSITIVE_INFINITY,
});

/**
 * Records what the hub last said about this device. Removal is final for the page: only Ask again,
 * which loads it afresh, leaves it, so no later answer brings back a screen the hub refused.
 */
export const setDeviceAccess = (queryClient: QueryClient, access: DeviceAccess) =>
  queryClient.setQueryData<DeviceAccess>(accessKey, (current) => (current === "removed" ? current : access));

export const useDeviceAccess = (): DeviceAccess => useQuery(deviceAccessQuery).data ?? "approved";

/** What a failed call says about this device: removed, out of reach, or nothing. */
export const accessAfter = (error: unknown): DeviceAccess | null => {
  if (!(error instanceof ApiError)) return null;
  if (error.tag === "DeviceRevoked") return "removed";
  const reason = error.fields.reason as { readonly _tag?: unknown } | undefined;
  return error.tag === "HttpClientError" && reason?._tag === "TransportError" ? "unreachable" : null;
};

/** Marks this device removed when any call is refused as revoked; other failures change nothing. */
export const noteRefusal = (queryClient: QueryClient, error: unknown) => {
  if (accessAfter(error) === "removed") setDeviceAccess(queryClient, "removed");
};

// The hub refused this device: asking again gets the same answer.
const REFUSALS = new Set(["DeviceRevoked", "DeviceRequired"]);

/**
 * A query's retry rule: a refusal is noted at once and never retried, so the only answer that says
 * this device was revoked is never lost behind retries; anything else is tried up to three times.
 */
export const retryUnlessRefused = (queryClient: QueryClient, failures: number, error: unknown): boolean => {
  noteRefusal(queryClient, error);
  if (error instanceof ApiError && REFUSALS.has(error.tag ?? "")) return false;
  return failures < 3;
};

// Each client's latest probe: only its answer counts, however the answers arrive.
const latestProbe = new WeakMap<QueryClient, number>();

/**
 * Asks the hub why the event stream closed: an approved device's read either works, is refused as
 * revoked, or gets no answer. The stream itself cannot say, since a browser hides its status.
 */
export const probeAccess = async (
  queryClient: QueryClient,
  list: () => Promise<unknown> = () => call((c) => c.devices.list()),
) => {
  const probe = (latestProbe.get(queryClient) ?? 0) + 1;
  latestProbe.set(queryClient, probe);
  const access = await list().then(
    (): DeviceAccess | null => "approved",
    (error: unknown) => accessAfter(error),
  );
  // A revocation is kept whenever it arrives; any other answer only from the latest probe.
  if (access === "removed" || (access !== null && latestProbe.get(queryClient) === probe)) {
    setDeviceAccess(queryClient, access);
  }
};
