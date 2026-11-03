import { useEffect, useState } from "react";
import type { ConnectionView } from "./client.ts";

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

/** Whether the connected desktop says the hub cannot be used now; connecting is not a problem yet. */
export const hasProblem = (view: ConnectionView | null): view is ConnectionView =>
  view !== null && view.state !== "connected" && view.state !== "connecting";
