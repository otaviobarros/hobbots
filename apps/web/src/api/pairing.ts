import type { PairingStatus, WaitingDevice } from "@hobbots/api";
import { type PairingRequest, pairingDeferred } from "@hobbots/domain";
import { type QueryClient, queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, call } from "./client.ts";
import { followsEvents } from "./queries.ts";

/**
 * Pairing (ADR 021). An approved device sees who waits and decides; a browser without a device asks
 * and waits on the pairing screen. The hub journals every change, so the list follows the event stream.
 */
const waitingKey = ["pairing", "waiting"] as const;

/** Every device waiting for an answer, deferred ones included, oldest first. */
export const waitingDevicesQuery = queryOptions({
  queryKey: waitingKey,
  queryFn: () => call((c) => c.pairingRequests.list()),
  ...followsEvents,
});

/** A device asked, or its request changed: the list is read again, as the hub decides who is listed. */
export const pairingChanged = (queryClient: QueryClient) =>
  queryClient.invalidateQueries({ queryKey: waitingKey, exact: true });

const NONE: ReadonlyArray<WaitingDevice> = [];

/** The devices still to be answered now: not put off with Decide later. */
export const promptedDevices = (waiting: ReadonlyArray<WaitingDevice>): ReadonlyArray<WaitingDevice> =>
  waiting.filter((device) => !pairingDeferred(device.request));

/** The devices waiting for an answer now, kept live by the journal; none until read. */
export const usePromptedDevices = (): ReadonlyArray<WaitingDevice> =>
  useQuery({ ...waitingDevicesQuery, select: promptedDevices }).data ?? NONE;

export type PairingDecision = "allow" | "deny" | "later";

/** Allow, Deny or Decide later. A refusal, most likely decided elsewhere or expired, reads the list again. */
export const useDecidePairing = (request: PairingRequest) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (decision: PairingDecision) =>
      call((c) => c.pairingRequests[decision]({ params: { requestId: request.id } })),
    onSettled: () => pairingChanged(queryClient),
  });
};

/** What the waiting screen shows: not asked yet, waiting, or how the request ended. */
export type WaitingState =
  | { readonly _tag: "Ask" }
  | { readonly _tag: "Waiting"; readonly status: PairingStatus }
  | { readonly _tag: "Allowed" }
  | { readonly _tag: "Denied" }
  | { readonly _tag: "Expired" }
  | { readonly _tag: "Throttled"; readonly seconds: number }
  | { readonly _tag: "NotYours" };

/** The waiting screen's state for a status the hub answered. */
export const waitingState = (status: PairingStatus): WaitingState => {
  switch (status.state) {
    case "pending":
      return { _tag: "Waiting", status };
    case "allowed":
    case "claimed":
      return { _tag: "Allowed" };
    case "denied":
      return { _tag: "Denied" };
    default:
      return { _tag: "Expired" };
  }
};

/** The waiting screen's state for a refused ask, or undefined when the refusal is not one it explains. */
export const refusedState = (error: unknown): WaitingState | undefined => {
  if (!(error instanceof ApiError)) return undefined;
  if (error.tag === "PairingThrottled") {
    const seconds = error.fields.retryAfterSeconds;
    return { _tag: "Throttled", seconds: typeof seconds === "number" ? seconds : 60 };
  }
  if (error.tag === "PairingRefused" && error.fields.reason === "notYours") return { _tag: "NotYours" };
  return undefined;
};

/**
 * Where this browser's request stands. With no request, or one whose secret no longer answers, it
 * has not asked yet. The hub hands the token over as a cookie the page never sees.
 */
const readPairing = async (): Promise<WaitingState> => {
  try {
    return waitingState(await call((c) => c.pairing.status()));
  } catch (error) {
    if (error instanceof ApiError && error.tag === "PairingNotFound") return { _tag: "Ask" };
    const refused = refusedState(error);
    if (refused !== undefined) return refused;
    throw error;
  }
};

/** Asks the hub to let this browser in, under `name`. Asking again while a request waits returns it. */
const askToPair = async (name: string, platform: string): Promise<WaitingState> => {
  try {
    const opened = await call((c) => c.pairing.open({ payload: { name, platform, kind: "browser" } }));
    return waitingState(opened.status);
  } catch (error) {
    const refused = refusedState(error);
    if (refused !== undefined) return refused;
    throw error;
  }
};

const statusKey = ["pairing", "status"] as const;

/** Every two seconds, as ADR 021 has a waiting device ask. */
const POLL_MS = 2000;

/**
 * Where this browser's request stands, asked again every two seconds while it waits, so the screen
 * moves on by itself once the hub answers.
 */
export const pairingStatusQuery = queryOptions({
  queryKey: statusKey,
  queryFn: readPairing,
  staleTime: 0,
  refetchInterval: (query) => (query.state.data?._tag === "Waiting" ? POLL_MS : false),
});

/** Asks, or asks again, and shows what the hub answered. */
export const useAskToPair = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ name, platform }: { readonly name: string; readonly platform: string }) => askToPair(name, platform),
    onSuccess: (state) => queryClient.setQueryData(statusKey, state),
  });
};

/** Back to the form, to ask again after a Deny, an expiry or a wait. */
export const useStartOver = () => {
  const queryClient = useQueryClient();
  return () => queryClient.setQueryData<WaitingState>(statusKey, { _tag: "Ask" });
};

/** The hub's name, for "Waiting for approval on <hub name>"; undefined when the hub does not say. */
export const hubNameQuery = queryOptions({
  queryKey: ["health", "name"] as const,
  queryFn: () =>
    call((c) => c.health.health()).then(
      (health) => health.name ?? null,
      () => null,
    ),
  staleTime: Number.POSITIVE_INFINITY,
});

// Once a request was admitted, this page has a device until it reloads.
let admitted = false;

/**
 * Whether this page has no device on the hub, so it shows the pairing screen (ADR 021). The desktop
 * app's window always has one: it sets the window key again itself after the hub restarts.
 */
export const needsPairing = async (): Promise<boolean> => {
  if (admitted || globalThis.window?.hobbots !== undefined) return false;
  try {
    await call((c) => c.setup.get());
    admitted = true;
    return false;
  } catch (error) {
    // Any other failure, such as a hub that is restarting, is left to the page to show.
    return error instanceof ApiError && error.tag === "DeviceRequired";
  }
};

const BROWSERS: ReadonlyArray<readonly [RegExp, string]> = [
  [/Edg\//, "Edge"],
  [/OPR\/|Opera/, "Opera"],
  [/Firefox\/|FxiOS/, "Firefox"],
  [/Chrome\/|CriOS/, "Chrome"],
  [/Safari\//, "Safari"],
];

const PLATFORMS: ReadonlyArray<readonly [RegExp, string]> = [
  [/iPhone/, "iPhone"],
  [/iPad/, "iPad"],
  [/Android/, "Android"],
  [/Mac OS X|Macintosh/, "Mac"],
  [/Windows/, "Windows"],
  [/CrOS/, "ChromeOS"],
  [/Linux/, "Linux"],
];

const first = (agent: string, table: ReadonlyArray<readonly [RegExp, string]>) =>
  table.find(([pattern]) => pattern.test(agent))?.[1];

/**
 * What a browser is and runs on, from its user agent, for the name it suggests before the user
 * changes it (ADR 021), such as Safari on an iPhone. Undefined where the agent does not say.
 */
export const describeBrowser = (
  agent: string,
): { readonly browser: string | undefined; readonly platform: string | undefined } => ({
  browser: first(agent, BROWSERS),
  platform: first(agent, PLATFORMS),
});
