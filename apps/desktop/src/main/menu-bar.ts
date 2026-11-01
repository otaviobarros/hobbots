/**
 * Hobbots as a menu-bar app (ADR 012, design screen 14): the menu-bar icon, what closing the window
 * does, the Dock icon only while a window is open, and Quit stopping the server before the app exits.
 */
import { app, type BrowserWindow, dialog, Menu, nativeImage, Tray } from "electron";
import { keepsRunning } from "./keep-running.ts";
import { closeAction, quitWhileWorkingDialog, renderTrayIcon, TRAY_SIZE, trayModel } from "./menu-bar-model.ts";
import type { ServerState, ServerSupervisor } from "./server.ts";
import type { SettingsStore } from "./settings.ts";
import { reveal } from "./single-instance.ts";
import { type WorkingHob, workingHobs } from "./working-hobs.ts";

export interface MenuBarOptions {
  readonly supervisor: ServerSupervisor;
  readonly settings: SettingsStore;
  readonly apiUrl: string;
  readonly port: number;
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

export const startMenuBar = ({ supervisor, settings, apiUrl, port, createWindow }: MenuBarOptions) => {
  const windows = new Set<BrowserWindow>();
  let working: ReadonlyArray<string> = [];
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
      const response = await fetch(`${apiUrl}/api/activity`, { signal: AbortSignal.timeout(1000) });
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

  const tray = new Tray(trayImage(supervisor.status.state));
  let drawn = "";
  const refresh = () => {
    const status = supervisor.status;
    const model = trayModel(status, working, port);
    const key = JSON.stringify([status, model]);
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
        // Remote access arrives with slice 13.
        { label: "Pause remote access", sublabel: "Later", enabled: false },
        { type: "separator" },
        { label: "Quit Hobbots", accelerator: "CmdOrCtrl+Q", click: () => app.quit() },
      ]),
    );
  };
  supervisor.onChange(refresh);
  refresh();

  const names = (hobs: ReadonlyArray<WorkingHob>) => hobs.map((hob) => hob.name);
  // Read again when a reply starts or ends, until the read agrees with the event.
  const workingReads = workingHobs({
    read: fetchWorking,
    onRead: (hobs) => {
      working = names(hobs);
      refresh();
    },
  });

  /**
   * Checks the server and reads which hobs are working, when the event stream connects, ends or
   * cannot connect.
   * The open stream is what shows the server is alive, so nothing is checked on a timer.
   */
  const checkServer = () => workingReads.startOver(() => supervisor.check());

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
      const model = trayModel(supervisor.status, [], port);
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

  return { startServer, showWindow, checkServer, activityChanged: workingReads.changed };
};
