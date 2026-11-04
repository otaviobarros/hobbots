import { Schema } from "effect";
import type { Disconnected } from "./disconnect.ts";
import type { ConnectionState } from "./hub-connection.ts";
import type { AddressChange } from "./hub-move.ts";
import { type ConnectionAction, connectedTrayModel } from "./menu-bar-model.ts";
import type { HubConnection } from "./settings.ts";
import { handleTrusted, noArgs, type TrustedIpcOptions, withArgs } from "./trusted-ipc.ts";

/** The channels the preload bridge calls on a connected desktop for the hub it uses (ADR 025). */
export const connectionChannels = {
  get: "hobbots:connection:get",
  /** Checks the hub again now, instead of at the next try. */
  retry: "hobbots:connection:retry",
  /** Moves to an address the user typed, on the same computer. */
  changeAddress: "hobbots:connection:change-address",
  /** Opens Tailscale on this computer, so the user can turn it on. */
  openTailscale: "hobbots:connection:open-tailscale",
  /** Sent to the window with each new view, so its banner follows the connection. */
  changed: "hobbots:connection:changed",
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
  /** Why the hub cannot be used now, and what to do, in the menu bar's words (ADR 025). */
  readonly title: string;
  readonly detail: string;
  /** What the user can do about the state; the page offers only the ones the bridge has calls for. */
  readonly actions: ReadonlyArray<ConnectionAction>;
}

export const connectionView = (
  connection: HubConnection,
  state: ConnectionState,
  appVersion: string,
  hubVersion: string | null,
): ConnectionView => {
  const { title, detail, actions } = connectedTrayModel(state, connection);
  return {
    hubName: connection.name,
    nodeName: connection.nodeName,
    address: connection.address,
    deviceId: connection.deviceId,
    appVersion,
    hubVersion,
    state: state.state,
    title,
    detail,
    actions,
  };
};

/** The answer to `changeAddress`: done, or the reason in the user's words. */
export type AddressChangeAnswer = { readonly ok: true } | { readonly ok: false; readonly message: string };

const addressAnswer = (change: AddressChange): AddressChangeAnswer =>
  change._tag === "Moved" ? { ok: true } : { ok: false, message: change.message };

/** Answers the bridge's connection calls, Disconnect among them, only from the hub's pages. */
export const handleConnectionIpc = (
  options: TrustedIpcOptions & {
    readonly view: () => ConnectionView;
    readonly retry: () => Promise<void>;
    readonly changeAddress: (typed: string) => Promise<AddressChange>;
    readonly openTailscale: () => Promise<boolean>;
    /** Disconnects from the hub; the app then starts again at setup's first screen. */
    readonly disconnect: () => Promise<Disconnected>;
  },
) =>
  handleTrusted(options, {
    [connectionChannels.get]: noArgs(() => options.view()),
    [connectionChannels.retry]: noArgs(async () => {
      await options.retry();
      return options.view();
    }),
    [connectionChannels.changeAddress]: withArgs(Schema.Tuple([Schema.String]), async ([typed]) =>
      addressAnswer(await options.changeAddress(typed)),
    ),
    [connectionChannels.openTailscale]: noArgs(() => options.openTailscale()),
    [connectionChannels.disconnect]: noArgs(() => options.disconnect()),
  });
