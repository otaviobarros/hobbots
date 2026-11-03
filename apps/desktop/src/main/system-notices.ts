import { BrowserWindow, Notification, type BrowserWindow as Window } from "electron";
import type { LoginItem } from "./login-item.ts";
import { notificationChoices, notifyWhenOn } from "./notification-choices.ts";
import { openRequestIn } from "./open-request.ts";
import { deviceNotices, type RequestNoticesOptions, requestNotices } from "./request-notices.ts";
import type { SettingsStore } from "./settings.ts";
import { onSecondLaunch } from "./single-instance.ts";

/**
 * Sends a system notification for each new request, and each device asking to pair (ADR 021), while
 * no Hobbots window is focused, from the main process so it works with every window closed. `fetch`
 * reads a hub route as this app: with the window key on the hub, with the device token on a
 * connected desktop (PE-006).
 */
export const systemNotices = (options: {
  readonly fetch: (path: string, init: RequestInit) => Promise<Response>;
  readonly showWindow: () => Promise<Window | undefined>;
  readonly settings: SettingsStore;
}) => {
  const show = ({ title, body, silent }: { title: string; body: string; silent: boolean }, onClick: () => void) => {
    const notice = new Notification({ title, body, silent });
    notice.on("click", onClick);
    notice.show();
    return notice;
  };
  const open = async (requestId: string) => {
    const window = await options.showWindow();
    if (window && requestId !== "") openRequestIn(window, requestId);
  };
  const choices = () => notificationChoices(options.settings);
  const notices: RequestNoticesOptions = {
    read: async (path) => {
      try {
        const response = await options.fetch(path, { signal: AbortSignal.timeout(2000) });
        return response.ok ? await response.json() : null;
      } catch {
        return null;
      }
    },
    isFocused: () => BrowserWindow.getFocusedWindow() !== null,
    notify: notifyWhenOn("requests", choices, show),
    open: (requestId) => void open(requestId),
  };
  const requests = requestNotices(notices);
  // A device's prompt shows over the window, so its notification only needs to bring the window forward.
  const devices = deviceNotices({
    ...notices,
    notify: notifyWhenOn("devices", choices, show),
    open: () => void open(""),
  });
  return { requests, devices };
};
export type SystemNotices = ReturnType<typeof systemNotices>;

/**
 * Shows the window on a second launch, the Dock icon or opening the app from Finder; opened at
 * login, Hobbots starts in the menu bar instead.
 */
export const showOnLaunch = async (
  app: Electron.App,
  loginItem: LoginItem,
  showWindow: () => Promise<Window | undefined>,
) => {
  onSecondLaunch(() => void showWindow());
  // macOS already fronts a visible window.
  app.on("activate", (_event, hasVisibleWindows) => {
    if (!hasVisibleWindows) void showWindow();
  });
  if (loginItem.openedAtLogin) {
    if (process.platform === "darwin") app.setActivationPolicy("accessory");
  } else {
    await showWindow();
  }
};
