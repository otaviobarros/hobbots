/**
 * Disconnect on a connected desktop (ADR 025): the hub revokes this device, the keychain item and
 * the window's device cookies go, and the mode is cleared, so the next start is setup's first
 * screen. Electron stays out of this file; connected-mode.ts passes the hub, the keychain, the
 * cookies and the settings in.
 */
import type { ConnectedHub, ConnectionState } from "./hub-connection.ts";
import type { HubConnection, SettingsStore } from "./settings.ts";
import type { DeviceTokenStore } from "./tailnet.ts";

/** How long the hub has to answer the revoke before this computer forgets it anyway. */
const REVOKE_TIMEOUT_MS = 5000;

export interface DisconnectOptions {
  readonly connection: HubConnection;
  /** Where the connection stands now. */
  readonly state: () => ConnectionState;
  readonly hub: Pick<ConnectedHub, "fetchAsDevice">;
  readonly token: Pick<DeviceTokenStore, "read" | "remove">;
  /** Removes both device cookies from the window's session. */
  readonly clearCookies: () => Promise<void>;
  readonly settings: SettingsStore;
}

/** What Disconnect did: `stillListed` when the hub could not be reached, so it still lists this device. */
export interface Disconnected {
  readonly stillListed: boolean;
}

/**
 * Asks the hub to revoke this device, as this device. True once the hub no longer lists it as
 * allowed: revoked now, or refused already, as revoked or unknown (`401`), or not listed (`404`).
 */
const revokeOnHub = async (hub: DisconnectOptions["hub"], deviceId: string, token: string): Promise<boolean> => {
  try {
    const response = await hub.fetchAsDevice(
      `/api/devices/${encodeURIComponent(deviceId)}/revoke`,
      { method: "POST", signal: AbortSignal.timeout(REVOKE_TIMEOUT_MS) },
      token,
    );
    return response.ok || response.status === 401 || response.status === 404;
  } catch {
    // No answer, no token, or the address is now another node's: the token is never sent there.
    return false;
  }
};

/**
 * Disconnects this computer from its hub. The token is read and the keychain item deleted first: a
 * keychain that cannot delete it rejects before anything changes, here or on the hub, so the hub
 * still knows this device and Disconnect can be asked again. Then the window's cookies go, the hub
 * revokes the device with the token held in memory, unless it already refused it, and the mode is
 * cleared, reached or not. The settings remember that this computer left a hub, so the next start
 * asks what it is for instead of becoming a hub by itself.
 */
export const disconnectFromHub = async (options: DisconnectOptions): Promise<Disconnected> => {
  const state = options.state().state;
  const refused = state === "revoked" || state === "unknownDevice";
  const token = await options.token.read();
  await options.token.remove();
  await options.clearCookies();
  const revoked =
    refused || (token !== undefined && (await revokeOnHub(options.hub, options.connection.deviceId, token)));
  options.settings.update({ mode: undefined, connection: undefined, leftHub: true });
  // The app starts again only once the file says so; otherwise it would come back connected.
  await options.settings.saved();
  return { stillListed: !revoked };
};
