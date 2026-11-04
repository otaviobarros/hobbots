import { join } from "node:path";
import { BrowserWindow, dialog, screen, shell } from "electron";
import { FIRST_RUN_GROUND } from "./window-background.ts";
import { appWebPreferences, navigationGuard, windowOpenHandler } from "./window-policy.ts";
import { watchWindow } from "./window-recovery.ts";
import { initialWindowBounds } from "./window-size.ts";

/**
 * A new Hobbots window, not loaded yet: on the display the pointer is on, in the Hobbots title
 * strip, sandboxed, and kept on the pages `isAllowedUrl` accepts. External links open in the
 * default browser. `additionalArguments` reach the preload script, never the page. A page that
 * crashes, hangs or fails to load is logged and recovered (STD-DESKTOP-010).
 */
export const newAppWindow = (options: {
  readonly isAllowedUrl: (url: string) => boolean;
  /** The theme's ground, which shows before the page paints; first run's when left out. */
  readonly backgroundColor?: string;
  readonly additionalArguments?: ReadonlyArray<string>;
}) => {
  // Opens on the display the pointer is on, where the user is looking.
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const window = new BrowserWindow({
    ...initialWindowBounds(display.workArea),
    title: "Hobbots",
    backgroundColor: options.backgroundColor ?? FIRST_RUN_GROUND,
    // The traffic lights sit inside the 30px title strip of the Hobbots design.
    ...(process.platform === "darwin"
      ? { titleBarStyle: "hidden" as const, trafficLightPosition: { x: 12, y: 9 } }
      : { titleBarStyle: "default" as const }),
    webPreferences: appWebPreferences(
      join(import.meta.dirname, "../preload/index.cjs"),
      options.additionalArguments ?? [],
    ),
  });

  // External links open in the default browser; the app window never navigates away.
  window.webContents.setWindowOpenHandler(windowOpenHandler((url) => shell.openExternal(url)));
  const guard = navigationGuard(options.isAllowedUrl);
  window.webContents.on("will-navigate", (event, url) => guard(event, url));
  // A redirect, such as the hub's between its HTTP and HTTPS addresses, is held to the same pages.
  window.webContents.on("will-redirect", (event, url) => guard(event, url));
  watchWindow({
    page: window.webContents,
    isAllowedUrl: options.isAllowedUrl,
    ask: async ({ message, detail, buttons, signal }) =>
      (
        await dialog.showMessageBox(window, {
          type: "warning",
          message,
          detail,
          buttons: [...buttons],
          defaultId: 0,
          ...(signal !== undefined && { signal }),
        })
      ).response,
    close: () => window.close(),
  });
  return window;
};
