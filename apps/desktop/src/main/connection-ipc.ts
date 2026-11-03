import type { IpcMain, IpcMainInvokeEvent } from "electron";
import type { Disconnected } from "./disconnect.ts";
import type { ConnectionState } from "./hub-connection.ts";
import type { HubConnection } from "./settings.ts";
import { handleTrusted } from "./trusted-ipc.ts";

/** The channels the preload bridge calls on a connected desktop for the hub it uses (ADR 025). */
export const connectionChannels = {
  get: "hobbots:connection:get",
  disconnect: "hobbots:connection:disconnect",
} as const;

/** What a connected desktop's pages learn about its connection: names, address, versions and state, never the token. */
export interface ConnectionView {
  readonly hubName: string;
  readonly nodeName: string;
  readonly address: string;
  /** This computer's device on the hub, so its pages can tell it apart in the hub's list. */
  readonly deviceId: string;
  readonly appVersion: string;
  /** The hub's version as its health endpoint last said, or null before it answered. */
  readonly hubVersion: string | null;
  readonly state: ConnectionState["state"];
}

export const connectionView = (
  connection: HubConnection,
  state: ConnectionState,
  appVersion: string,
  hubVersion: string | null,
): ConnectionView => ({
  hubName: connection.name,
  nodeName: connection.nodeName,
  address: connection.address,
  deviceId: connection.deviceId,
  appVersion,
  hubVersion,
  state: state.state,
});

/** Answers the bridge's `connection.get` and `connection.disconnect`, only from the hub's pages. */
export const handleConnectionIpc = (options: {
  readonly ipcMain: Pick<IpcMain, "handle">;
  readonly isTrusted: (event: IpcMainInvokeEvent) => boolean;
  readonly view: () => ConnectionView;
  /** Disconnects from the hub; the app then starts again at setup's first screen. */
  readonly disconnect: () => Promise<Disconnected>;
}) =>
  handleTrusted(options, {
    [connectionChannels.get]: () => options.view(),
    [connectionChannels.disconnect]: () => options.disconnect(),
  });
