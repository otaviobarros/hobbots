import { BrowserWindow, Notification, type BrowserWindow as Window } from "electron";
import type { HubChange } from "./hub-events-model.ts";
import type { LoginItem } from "./login-item.ts";
import { notificationChoices, notifyWhenOn } from "./notification-choices.ts";
import { openRequestIn, openTaskIn } from "./open-request.ts";
import {
  deviceNotices,
  failedTaskNotices,
  finishedNotices,
  questionNotices,
  type RequestNoticesOptions,
  requestNotices,
  shareNotices,
} from "./request-notices.ts";
import type { TaskLink } from "./request-notices-model.ts";
import type { SettingsStore } from "./settings.ts";
import { onSecondLaunch } from "./single-instance.ts";

/**
 * Sends a system notification for each new request, question that reached you and failed Task of a
 * party member, each Quest that finished (ADR 027), each hob asking to share what it learned (ADR
 * 028), and each device asking to pair (ADR 021), while
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
  const openTask = async (link: TaskLink | null) => {
    const window = await options.showWindow();
    if (window && link !== null) openTaskIn(window, link);
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
    openTask: (link) => void openTask(link),
  };
  const requests = requestNotices(notices);
  // A question or a failed Task needs you as a request does, under the same switch (ADR 027).
  const questions = questionNotices(notices);
  const failed = failedTaskNotices(notices);
  // A share request is a Memory kind in the Inbox, under the same switch (ADR 028).
  const shares = shareNotices(notices);
  const finishes = finishedNotices({ ...notices, notify: notifyWhenOn("finishes", choices, show) });
  // A device's prompt shows over the window, so its notification only needs to bring the window forward.
  const devices = deviceNotices({
    ...notices,
    notify: notifyWhenOn("devices", choices, show),
    open: () => void open(""),
  });
  return {
    /** The event stream connected: anything may have changed while it was away, so every list is read. */
    connected: () => {
      void requests.check();
      void questions.check();
      void failed.check();
      void shares.check();
      void devices.check();
    },
    /** Reads again the list a change makes stale, or announces a finished Quest. */
    changed: (change: HubChange) => {
      if (change._tag === "Approvals") void requests.check();
      else if (change._tag === "Questions") void questions.check();
      else if (change._tag === "Tasks") void failed.check();
      else if (change._tag === "Pairing") void devices.check();
      else if (change._tag === "Shares") void shares.check();
      else if (change._tag === "QuestFinished") void finishes.finished(change.quest);
    },
  };
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
