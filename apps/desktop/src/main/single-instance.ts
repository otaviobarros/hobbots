import { app, type BrowserWindow } from "electron";

/**
 * Takes Electron's single-instance lock (ADR 012). False in a second launch, which must quit: the
 * first instance gets `second-instance` and shows its window instead.
 */
export const claimSingleInstance = (): boolean => app.requestSingleInstanceLock();

/** Calls `show` when Hobbots is launched again while this instance runs. */
export const onSecondLaunch = (show: () => void) => {
  app.on("second-instance", () => show());
};

/** Brings a window to the front, restoring it if minimized or hidden. */
export const reveal = (window: BrowserWindow) => {
  if (window.isMinimized()) window.restore();
  window.show();
  // A launch from Finder or the Dock leaves another app in front on macOS.
  if (process.platform === "darwin") app.focus({ steal: true });
  window.focus();
};
