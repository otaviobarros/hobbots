import { type FocusTargets, firstControl } from "../move-on/follow-focus.ts";
import { composerIn, nextWaiting } from "../move-on/places.ts";

/** Marks what holds the tray on Home, so focus has somewhere to go once nothing waits in it. */
export const TRAY_HOST = { "data-tray-host": "" } as const;

/**
 * Where focus goes after you decide in the Needs-you tray (#995): the item that takes the decided
 * one's place, or once the tray is gone, the chat's composer, or on Home the first control of the
 * Needs you section, its way to the Inbox.
 */
export const trayTargets: FocusTargets = (from) => {
  const tray = from.closest("[data-tray]");
  const host = tray?.parentElement?.closest("main, [data-tray-host]") ?? null;
  return {
    next: () => (tray?.isConnected ? nextWaiting(tray, from) : null),
    fallback: () => composerIn(host) ?? firstControl(host),
  };
};
