import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import type { ConnectionAction } from "./client.ts";

type ConnectionCalls = NonNullable<NonNullable<Window["hobbots"]>["connection"]>;

/** A call the bridge offers, or undefined when this app's bridge does not have it. */
const call = <F>(found: F | undefined): F | undefined => (typeof found === "function" ? found : undefined);

/**
 * What a connected desktop's bridge offers for its hub (ADR 025), checked call by call, since a
 * hub's pages may load in an older app: `get` to show the hub, and each other call only when this
 * app has it. Undefined on the hub's own window, in a browser, or in an app that cannot say.
 */
export const connectionCalls = (connection: ConnectionCalls | undefined) => {
  const get = call(connection?.get);
  if (get === undefined) return undefined;
  return {
    get,
    disconnect: call(connection?.disconnect),
    retry: call(connection?.retry),
    changeAddress: call(connection?.changeAddress),
    openTailscale: call(connection?.openTailscale),
    onChange: call(connection?.onChange),
  };
};

export const connectionBridge = connectionCalls(globalThis.window?.hobbots?.connection);
export type ConnectionBridge = NonNullable<typeof connectionBridge>;

const connectionKey = ["desktop", "connection"] as const;

/**
 * The hub a connected desktop uses and where the connection stands, read from the desktop app,
 * never from the hub. Local IPC, so it runs while the hub cannot be reached; disabled outside a
 * connected desktop.
 */
export const useDesktopConnection = () =>
  useQuery({
    queryKey: connectionKey,
    queryFn: () => (connectionBridge as ConnectionBridge).get(),
    enabled: connectionBridge !== undefined,
    networkMode: "always",
  });

/**
 * Follows the views the desktop app pushes as the connection changes, into the same query, as live
 * events update the hub's queries (STD-REACT-004: the effect only holds the subscription).
 */
export const useFollowDesktopConnection = () => {
  const queryClient = useQueryClient();
  useEffect(() => connectionBridge?.onChange?.((view) => queryClient.setQueryData(connectionKey, view)), [queryClient]);
};

/** Checks the hub again now; the app answers with the view that follows. */
export const useRetryConnection = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => connectionBridge?.retry?.(),
    onSuccess: (view) => {
      if (view !== undefined) queryClient.setQueryData(connectionKey, view);
    },
    networkMode: "always",
  });
};

/** Moves to an address the user typed; the app answers whether it took it, or why not. */
export const useChangeAddress = () =>
  useMutation({
    mutationFn: async (typed: string) =>
      (await connectionBridge?.changeAddress?.(typed)) ?? { ok: false as const, message: "" },
    networkMode: "always",
  });

/** Opens Tailscale on this computer. */
export const useOpenTailscale = () =>
  useMutation({ mutationFn: async () => connectionBridge?.openTailscale?.(), networkMode: "always" });

/** Why the hub cannot be used now, in the app's words, and what the user can do about it. */
export interface ConnectionReason {
  readonly title: string;
  readonly detail: string;
  readonly address: string;
  readonly actions: ReadonlyArray<ConnectionAction>;
}

const ACTIONS: ReadonlySet<string> = new Set(["tryAgain", "openTailscale", "changeAddress", "askAgain", "disconnect"]);

/**
 * The reason the connected desktop gives for a problem, or null while connected, connecting, or when
 * the app is from before the reasons and sends none (ADR 025): the page then keeps its own generic
 * banner. Anything the app sends is checked, since it may be of another version.
 */
export const reasonOf = (view: unknown): ConnectionReason | null => {
  if (typeof view !== "object" || view === null) return null;
  const { state, title, detail, address, actions } = view as Record<string, unknown>;
  if (state === "connected" || state === "connecting" || typeof title !== "string" || title === "") return null;
  return {
    title,
    detail: typeof detail === "string" ? detail : "",
    address: typeof address === "string" ? address : "",
    actions: Array.isArray(actions)
      ? actions.filter((action): action is ConnectionAction => typeof action === "string" && ACTIONS.has(action))
      : [],
  };
};
