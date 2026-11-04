import { Option, Schema } from "effect";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import type { SettingsStore } from "./settings.ts";

/**
 * The one place the main process answers the preload bridge (STD-DESKTOP-003). Every channel checks
 * that the frame asking shows a page the window may show, and parses what the page sent with an Effect
 * Schema before its handler sees it. A refused or malformed call answers an `IpcRefusal`, and a
 * handler that fails rejects with no more than the channel's name, so the page never learns more
 * about the main process than the answer it asked for.
 */

/** The answer to a call from a page the window may not show, or with arguments the channel does not take. */
interface IpcRefusal {
  readonly refused: "notAllowed" | "malformed";
}

const notAllowed: IpcRefusal = { refused: "notAllowed" };
const malformed: IpcRefusal = { refused: "malformed" };

/** What a channel does with a trusted call: the arguments are already parsed when it runs. */
export type IpcRoute = (event: IpcMainInvokeEvent, args: ReadonlyArray<unknown>) => unknown;

/** A channel that takes arguments: `args` parses the list the page passed, as a `Schema.Tuple`. */
export const withArgs =
  <S extends Schema.ConstraintDecoder<ReadonlyArray<unknown>>>(
    args: S,
    run: (args: S["Type"], event: IpcMainInvokeEvent) => unknown,
  ): IpcRoute =>
  (event, raw) => {
    const parsed = Schema.decodeUnknownOption(args)(raw);
    return Option.isSome(parsed) ? run(parsed.value, event) : malformed;
  };

/** A channel that takes nothing from the page: whatever the page sends never reaches `run`. */
export const noArgs =
  (run: (event: IpcMainInvokeEvent) => unknown): IpcRoute =>
  (event) =>
    run(event);

/** Who may call and where the channels are answered. */
export interface TrustedIpcOptions {
  readonly ipcMain: Pick<IpcMain, "handle">;
  readonly isTrusted: (event: IpcMainInvokeEvent) => boolean;
}

/** What a bridge for a desktop setting needs: where to answer, the saved settings, and who may ask. */
export interface SettingsIpcOptions extends TrustedIpcOptions {
  readonly settings: SettingsStore;
}

/**
 * Answers each channel with its route, only from pages the window is allowed to show. Returns the
 * channels, so a mode that hands over can stop answering them.
 */
export const handleTrusted = (
  { ipcMain, isTrusted }: TrustedIpcOptions,
  routes: Readonly<Record<string, IpcRoute>>,
): ReadonlyArray<string> => {
  for (const [channel, route] of Object.entries(routes)) {
    ipcMain.handle(channel, async (event, ...args: Array<unknown>) => {
      if (!isTrusted(event)) return notAllowed;
      try {
        return await route(event, args);
      } catch (error) {
        console.error(`The ${channel} handler failed`, error);
        throw new Error(`${channel} failed`);
      }
    });
  }
  return Object.keys(routes);
};
