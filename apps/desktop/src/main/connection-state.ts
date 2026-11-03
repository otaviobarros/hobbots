/**
 * Where a connected desktop's connection to its hub stands, and how it gets back by itself (ADR 025).
 * Electron stays out of this file; connected-mode.ts passes the hub, the keychain and the cookies in.
 */
import { coalesce } from "./coalesce.ts";
import { type ConnectedHub, type ConnectionState, WAITS_FOR_USER } from "./hub-connection.ts";

export interface ConnectionStateOptions {
  /** The hub as it is now; a changed address replaces it. */
  readonly hub: () => ConnectedHub;
  /** Drops what is kept about the hub's node, so a check that follows asks Tailscale again. */
  readonly forgetNode: () => void;
  /** Called once the hub refused this device, after its token is gone. */
  readonly forgetToken: () => Promise<void>;
}

/**
 * The connection's state, with `check` to look again. A check while the hub cannot be reached asks
 * Tailscale afresh, so the app notices at once when Tailscale or the hub's computer comes back. A
 * device the hub refused stays refused until the user acts.
 */
export const connectionStateOf = ({ hub, forgetNode, forgetToken }: ConnectionStateOptions) => {
  let state: ConnectionState = { state: "connecting" };
  let hubVersion: string | null = null;
  const listeners = new Set<(state: ConnectionState) => void>();
  const set = (next: ConnectionState) => {
    const changed = JSON.stringify(next) !== JSON.stringify(state);
    state = next;
    if (next.state === "connected") hubVersion = next.version;
    if (changed) for (const listener of listeners) listener(next);
  };
  /** Checks the node and the hub again; a hub that no longer knows this device forgets its token. */
  const check = coalesce(async () => {
    if (state.state === "revoked" || state.state === "unknownDevice") return;
    const current = hub();
    if (state.state !== "connected") forgetNode();
    const refusal = state.state === "connected" ? await current.refusal() : null;
    if (refusal !== null) {
      await forgetToken();
      return set({ state: refusal });
    }
    set(await current.verify());
  });
  return {
    get current() {
      return state;
    },
    get hubVersion() {
      return hubVersion;
    },
    set,
    check,
    /** Whether trying again now could change the state: not while connected, nor while waiting for the user. */
    get retries() {
      return state.state !== "connected" && !WAITS_FOR_USER.has(state.state);
    },
    onChange: (listener: (state: ConnectionState) => void) => void listeners.add(listener),
  };
};
