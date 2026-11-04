import type { ConnectEnd, HubListView, WaitingView } from "@hobbots/api";
import { Schema } from "effect";
import type { IpcMain } from "electron";
import { handleTrusted, noArgs, type TrustedIpcOptions, withArgs } from "./trusted-ipc.ts";

/**
 * The channels the local setup pages call (ADR 025): Run here, the hubs on the tailnet, Connect and
 * Cancel. `waiting` goes the other way, from the main process to the page that asked to connect.
 */
export const setupChannels = {
  runHere: "hobbots:setup:run-here",
  findHubs: "hobbots:setup:find-hubs",
  connect: "hobbots:setup:connect",
  cancel: "hobbots:setup:cancel",
  waiting: "hobbots:setup:waiting",
} as const;

/** Longer than any address a person types; anything longer is not one. */
const MAX_ADDRESS = 300;

/** What setup does for its pages, each step in the main process. */
export interface SetupActions {
  /** Makes this computer the hub and starts its server; the hub's own window takes over. */
  readonly runHere: () => Promise<void>;
  readonly findHubs: () => Promise<HubListView>;
  /** Connects to the address the user typed or picked, telling `onWaiting` once the hub has a prompt. */
  readonly connect: (typed: string, onWaiting: (waiting: WaitingView) => void) => Promise<ConnectEnd>;
  /** Stops waiting for the hub; the connect under way then ends as cancelled. */
  readonly cancel: () => void;
}

/**
 * Answers the setup channels, only from the local pages. The page hands over nothing but the text the
 * user typed, which the main process checks against this computer's Tailscale before any request.
 */
export const handleSetupIpc = (
  options: TrustedIpcOptions & {
    readonly ipcMain: Pick<IpcMain, "handle" | "removeHandler">;
    readonly setup: SetupActions;
  },
) => {
  const { ipcMain, setup } = options;
  const channels = handleTrusted(options, {
    [setupChannels.runHere]: noArgs(() => setup.runHere()),
    [setupChannels.findHubs]: noArgs(() => setup.findHubs()),
    [setupChannels.connect]: withArgs(Schema.Tuple([Schema.String]), ([typed], event) => {
      // The user can type a long address, so it answers in Connect's own words rather than as malformed.
      if (typed.length > MAX_ADDRESS) return { kind: "refused", refusal: { reason: "Malformed" } } satisfies ConnectEnd;
      return setup.connect(typed, (waiting) => {
        if (!event.sender.isDestroyed()) event.sender.send(setupChannels.waiting, waiting);
      });
    }),
    [setupChannels.cancel]: noArgs(() => setup.cancel()),
  });
  /** Stops answering, once this computer has become a hub or a connected desktop. */
  return () => {
    for (const channel of channels) ipcMain.removeHandler(channel);
  };
};
