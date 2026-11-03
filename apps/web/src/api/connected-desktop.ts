import { useEffect, useState } from "react";
import type { ConnectionAction, ConnectionView } from "./client.ts";

/**
 * The connected desktop's view of its hub (ADR 025), followed as it changes; null in a browser or
 * on the hub's own computer, where the bridge has no `connection`.
 */
export const useConnectedDesktop = (): ConnectionView | null => {
  const [view, setView] = useState<ConnectionView | null>(null);
  useEffect(() => {
    const bridge = globalThis.window?.hobbots?.connection;
    if (bridge === undefined) return;
    let live = true;
    void bridge.get().then((first) => {
      if (live) setView(first);
    });
    const stop = bridge.onChange?.((next) => setView(next));
    return () => {
      live = false;
      stop?.();
    };
  }, []);
  return view;
};

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
