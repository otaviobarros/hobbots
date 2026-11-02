/**
 * Hobbots as a menu-bar app (ADR 012, design screen 14): the menu-bar icon, what closing the window
 * does, the Dock icon only while a window is open, and Quit stopping the server before the app exits.
 */
import { Option, Schema } from "effect";
import { app, type BrowserWindow, dialog, Menu, nativeImage, Tray } from "electron";
import { coalesce } from "./coalesce.ts";
import type { HubAddress } from "./hub-address.ts";
import { RemoteAccessView } from "./hub-events-model.ts";
import { keepsRunning } from "./keep-running.ts";
import {
  closeAction,
  pauseItem,
  quitWhileWorkingDialog,
  type RemoteAccessSwitch,
  renderTrayIcon,
  TRAY_SIZE,
  trayModel,
} from "./menu-bar-model.ts";
import { readUntil } from "./read-until.ts";
import type { ServerState, ServerSupervisor } from "./server.ts";
import type { SettingsStore } from "./settings.ts";
import { reveal } from "./single-instance.ts";

/** A hob with a turn in progress, and the thread it runs in. */
interface WorkingHob {
  readonly threadId: string;
  readonly name: string;
}

export interface MenuBarOptions {
  readonly supervisor: ServerSupervisor;
  readonly settings: SettingsStore;
  /** Read each time: the hub's port can change while the app runs. */
  readonly hub: HubAddress;
  /** Fetches from the hub as the hub's window, with the window key (ADR 021). */
  readonly fetchHub: (url: string, init?: RequestInit) => Promise<Response>;
  readonly createWindow: () => Promise<BrowserWindow>;
}

const trayImage = (state: ServerState) => {
  const image = nativeImage.createEmpty();
  for (const scale of [1, 2] as const) {
    image.addRepresentation({
      scaleFactor: scale,
      width: TRAY_SIZE * scale,
      height: TRAY_SIZE * scale,
      buffer: renderTrayIcon(state, scale),
    });
  }
  image.setTemplateImage(true);
  return image;
};

const decodeRemoteAccess = Schema.decodeUnknownOption(RemoteAccessView);

export const startMenuBar = ({ supervisor, settings, hub, fetchHub, createWindow }: MenuBarOptions) => {
  const windows = new Set<BrowserWindow>();
  let working: ReadonlyArray<string> = [];
  // Remote access as the hub last said, for Pause remote access; null until it answers.
  let remote: RemoteAccessSwitch | null = null;
  let starting: Promise<void> = Promise.resolve();
  let quitting = false;
  let confirming = false;

  /**
   * Names of the hobs with a turn in progress. Null when that is unknown: a server this app
   * launched is alive but did not answer, so its hobs may still be working.
   */
  const fetchWorking = async (): Promise<ReadonlyArray<WorkingHob> | null> => {
    if (!isRunning()) return supervisor.ownsProcess ? null : [];
    try {
      const response = await fetchHub(`${hub.apiUrl}/api/activity`, { signal: AbortSignal.timeout(1000) });
      if (!response.ok) return null;
      const body = (await response.json()) as { working?: unknown };
      if (!Array.isArray(body.working)) return null;
      return body.working.flatMap((hob: { name?: unknown; threadId?: unknown }) =>
        typeof hob?.name === "string" && typeof hob.threadId === "string"
          ? [{ name: hob.name, threadId: hob.threadId }]
          : [],
      );
    } catch {
      return null;
    }
  };

  const isRunning = () => supervisor.status.state === "running";

  const startServer = () => {
    starting = supervisor.start().catch((error) => console.error(error));
    return starting;
  };

  /** Reads remote access from the hub's answer, keeping what it knew when the answer is not one. */
  const takeRemoteAccess = (body: unknown) => {
    remote = Option.getOrElse(decodeRemoteAccess(body), () => remote);
    refresh();
  };

  const readRemoteAccess = async () => {
    if (!isRunning()) return;
    try {
      const response = await fetchHub(`${hub.apiUrl}/api/remote-access`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) takeRemoteAccess(await response.json());
    } catch {
      // The event stream says when the hub answers again.
    }
  };

  /** Pause remote access or Resume (ADR 021), as the hub's window, which needs no `Origin`. */
  const setPaused = async (paused: boolean) => {
    try {
      const response = await fetchHub(`${hub.apiUrl}/api/remote-access`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ paused }),
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error(`The hub answered ${response.status}`);
      takeRemoteAccess(await response.json());
    } catch (error) {
      console.error(error);
      await dialog.showMessageBox({
        type: "warning",
        message: paused ? "Hobbots could not pause remote access" : "Hobbots could not resume remote access",
        detail: "Check that the server is running, then try again.",
        buttons: ["OK"],
      });
    }
  };

  const tray = new Tray(trayImage(supervisor.status.state));
  let drawn = "";
  const refresh = () => {
    const status = supervisor.status;
    const model = trayModel(status, working, hub.port);
    const pause = pauseItem(status.state, remote);
    const key = JSON.stringify([status, model, pause]);
    if (key === drawn) return;
    drawn = key;
    tray.setImage(trayImage(status.state));
    tray.setToolTip(model.tooltip);
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: model.title, sublabel: model.detail, enabled: false },
        { type: "separator" },
        { label: "Open Hobbots", accelerator: "CmdOrCtrl+O", click: () => void showWindow() },
        { label: "Start the server again", visible: model.canRestart, click: () => void startServer() },
        ...(pause === null
          ? []
          : [{ label: pause.label, sublabel: pause.sublabel, click: () => void setPaused(pause.pause) }]),
        { type: "separator" },
        { label: "Quit Hobbots", accelerator: "CmdOrCtrl+Q", click: () => app.quit() },
      ]),
    );
  };
  supervisor.onChange(refresh);
  refresh();

  const checkHealth = () => supervisor.check();
  const names = (hobs: ReadonlyArray<WorkingHob>) => hobs.map((hob) => hob.name);
  /**
   * Reads which hobs are working. The hub announces a turn only once `/api/activity` reports it, so
   * one read per announcement is enough; a read that did not answer is made again until one does.
   */
  const readWorking = coalesce(async () => {
    working = names(await readUntil(fetchWorking));
    refresh();
  });

  /**
   * The event stream connected, ended or could not connect: the server is checked, then which hobs
   * are working is read again. Turn announcements are not replayed, so a resumed connection reads
   * again too. The open stream shows the server is alive, so nothing is checked on a timer.
   */
  const recheck = async () => {
    await checkHealth();
    await Promise.all([readWorking(), readRemoteAccess()]);
  };

  const guard = (window: BrowserWindow) => {
    windows.add(window);
    window.on("close", (event) => {
      const otherWindows = windows.size > 1;
      const options = { keepRunning: keepsRunning(settings), quitting, otherWindows };
      if (closeAction({ ...options, working: [] }) === "close") return;
      // Closing quits Hobbots; first learn whether that would stop hobs that are working.
      event.preventDefault();
      if (confirming) return;
      confirming = true;
      void (async () => {
        try {
          const read = await fetchWorking();
          const known = read && names(read);
          working = known ?? working;
          refresh();
          if (closeAction({ ...options, working: known }) === "quit") return app.quit();
          const { response } = await dialog.showMessageBox(window, {
            type: "warning",
            ...quitWhileWorkingDialog(known),
            defaultId: 0,
            cancelId: 1,
          });
          if (response === 0) app.quit();
        } finally {
          confirming = false;
        }
      })();
    });
    window.on("closed", () => {
      windows.delete(window);
      // The Dock icon shows only while a window is open.
      if (windows.size === 0 && process.platform === "darwin") app.setActivationPolicy("accessory");
    });
  };

  /**
   * Shows the window, opening one if none is open, and answers it; reports a server that is not
   * running and answers undefined when it stays stopped.
   */
  const showWindow = async (): Promise<BrowserWindow | undefined> => {
    await starting;
    if (!isRunning()) {
      const model = trayModel(supervisor.status, [], hub.port);
      const { response } = await dialog.showMessageBox({
        type: "warning",
        message: model.title,
        detail: model.detail,
        buttons: ["Start the server again", "Cancel"],
        defaultId: 0,
        cancelId: 1,
      });
      if (response !== 0) return;
      await startServer();
      if (!isRunning()) return;
    }
    if (process.platform === "darwin") app.setActivationPolicy("regular");
    const existing = [...windows][0];
    if (existing) {
      reveal(existing);
      return existing;
    }
    const window = await createWindow();
    guard(window);
    reveal(window);
    return window;
  };

  // With the switch on, the app outlives its windows on every platform; off, the close guard quits.
  app.on("window-all-closed", () => {
    if (!keepsRunning(settings)) app.quit();
  });

  // Quit (menu-bar icon, app menu or ⌘Q) cancels any start in progress and stops a server this app
  // launched, including one that stopped answering, then exits.
  let shutdown: Promise<void> | null = null;
  let stopped = false;
  app.on("before-quit", (event) => {
    quitting = true;
    if (stopped) return;
    event.preventDefault();
    shutdown ??= supervisor.shutdown().finally(() => {
      stopped = true;
      app.quit();
    });
  });

  return { startServer, showWindow, recheck, activityChanged: readWorking, remoteAccessChanged: takeRemoteAccess };
};
