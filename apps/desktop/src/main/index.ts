import { join, resolve } from "node:path";
import serverPath from "@hobbots/server/main?modulePath";
import { app, BrowserWindow, dialog, ipcMain, Notification, screen, shell, utilityProcess } from "electron";
import { handleFolderDialogIpc } from "./folder-dialog.ts";
import { followHub } from "./hub-events.ts";
import { handleKeepRunningIpc } from "./keep-running.ts";
import { handleLoginItemIpc, loginItemsSettingsUrl, makeLoginItem } from "./login-item.ts";
import { startMenuBar } from "./menu-bar.ts";
import { openRequestIn } from "./open-request.ts";
import { requestNotices } from "./request-notices.ts";
import { ServerSupervisor, StartTimedOut } from "./server.ts";
import { checkServer, requireOurs, ServerProblem, serverProblem } from "./server-identity.ts";
import { fileSettingsStore } from "./settings.ts";
import { loginShellPath, mergePaths } from "./shell-path.ts";
import { claimSingleInstance, onSecondLaunch } from "./single-instance.ts";
import { initialWindowBounds } from "./window-size.ts";

// Same name as the server's default data folder, so `pnpm dev` and the app share one installation.
app.setName("Hobbots");

// A second launch quits at once; the running instance shows its window instead.
const primary = claimSingleInstance();
if (!primary) app.quit();

// The packaged app's Info.plist supplies the copyright; these keep the name and version right in
// development too, and add the license notice.
app.setAboutPanelOptions({
  applicationName: "Hobbots",
  applicationVersion: app.getVersion(),
  credits: "Free and open-source software under the Apache License 2.0. See hobbots.app.",
});

const port = Number(process.env.HOBBOTS_PORT ?? 4317);
const apiUrl = `http://127.0.0.1:${port}`;
const devWebUrl = process.env.HOBBOTS_WEB_URL ?? "http://localhost:5173";

// A packaged app carries the web client in its resources folder; a checkout uses the web build.
// The server serves it, and the window loads it from there like any browser on the hub (ADR 012).
const webDir = app.isPackaged ? join(process.resourcesPath, "web") : resolve(import.meta.dirname, "../../../web/dist");

/** The pages the window may show, and the only ones the preload bridge answers. */
const isAllowedUrl = (url: string) => url.startsWith(`${devWebUrl}/`) || url.startsWith(`${apiUrl}/`);

const isUp = async (url: string) => {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(1000) })).ok;
  } catch {
    return false;
  }
};

/** This installation's server, attached to when it already runs or launched and owned by this app. */
const supervisor = new ServerSupervisor({
  apiUrl,
  probe: async () => {
    const check = await checkServer(apiUrl, app.getPath("userData"));
    if (check.kind === "none") return "none";
    requireOurs(check, port);
    return "ours";
  },
  launch: async () => {
    // A packaged app is opened from Finder or the Dock, without the shell's PATH.
    const path = app.isPackaged ? mergePaths(await loginShellPath(), process.env.PATH) : process.env.PATH;
    const server = utilityProcess.fork(serverPath, [], {
      serviceName: "Hobbots Server",
      stdio: "inherit",
      env: {
        ...process.env,
        PATH: path,
        HOBBOTS_PORT: String(port),
        HOBBOTS_DATA_DIR: app.getPath("userData"),
        HOBBOTS_VERSION: app.getVersion(),
        HOBBOTS_WEB_DIR: webDir,
        // A development build's window loads the Vite dev server, which then acts for the user.
        ...(!app.isPackaged && { HOBBOTS_ALLOWED_ORIGINS: devWebUrl }),
      },
    });
    server.on("exit", (code) => console.log(`Hobbots server exited with code ${code}`));
    return server;
  },
});

const createWindow = async () => {
  // Opens on the display the pointer is on, where the user is looking.
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const window = new BrowserWindow({
    ...initialWindowBounds(display.workArea),
    title: "Hobbots",
    backgroundColor: "#141228",
    // The traffic lights sit inside the 30px title strip of the Hobbots design.
    ...(process.platform === "darwin"
      ? { titleBarStyle: "hidden" as const, trafficLightPosition: { x: 12, y: 9 } }
      : { titleBarStyle: "default" as const }),
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      additionalArguments: [`--hobbots-api=${apiUrl}`],
    },
  });

  // External links open in the default browser; the app window never navigates away.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http")) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (!isAllowedUrl(url)) event.preventDefault();
  });

  if (!app.isPackaged && (await isUp(devWebUrl))) {
    await window.loadURL(devWebUrl);
  } else {
    await window.loadURL(`${apiUrl}/`);
  }
  return window;
};

/**
 * Sends a system notification for each new request while no Hobbots window is focused, from the
 * main process so it works with every window closed. The main process reads the Inbox as the app
 * itself, on the hub's own origin, as its window does (PE-006).
 */
const requestNoticesOn = (open: (requestId: string) => void) =>
  requestNotices({
    read: async (path) => {
      try {
        const response = await fetch(`${apiUrl}${path}`, {
          headers: { origin: apiUrl },
          signal: AbortSignal.timeout(2000),
        });
        return response.ok ? await response.json() : null;
      } catch {
        return null;
      }
    },
    isFocused: () => BrowserWindow.getFocusedWindow() !== null,
    notify: ({ title, body }, onClick) => {
      const notice = new Notification({ title, body });
      notice.on("click", onClick);
      notice.show();
      return notice;
    },
    open,
  });

/**
 * Follows the hub's event stream for the menu-bar icon and the request notifications, instead of
 * polling: they read the hub again only when the stream connects, is lost, or reports a change.
 */
const followHubFor = (
  menuBar: Pick<ReturnType<typeof startMenuBar>, "checkServer" | "activityChanged">,
  notices: ReturnType<typeof requestNotices>,
) => {
  const hub = followHub({
    url: `${apiUrl}/api/events`,
    headers: { origin: apiUrl },
    canConnect: () => supervisor.mayAnswer,
    onConnected: () => {
      void menuBar.checkServer();
      void notices.check();
    },
    onChange: (change) =>
      void (change._tag === "Approvals" ? notices.check() : menuBar.activityChanged(change.threadId, change.working)),
    onLost: () => void menuBar.checkServer(),
  });
  // Followed only while the server may answer; a server started again is followed at once.
  supervisor.onChange(() => hub.sync());
  app.on("will-quit", () => void hub.stop());
};

app.whenReady().then(async () => {
  if (!primary) return;
  const settings = fileSettingsStore(join(app.getPath("userData"), "desktop-settings.json"));
  const isTrusted = (event: Electron.IpcMainInvokeEvent) => isAllowedUrl(event.senderFrame?.url ?? "");
  // Only the installed app registers, so a checkout never adds Electron itself as a login item.
  const loginItem = makeLoginItem({
    supported: app.isPackaged && process.platform === "darwin",
    items: {
      read: () => app.getLoginItemSettings(),
      write: (openAtLogin) => app.setLoginItemSettings({ openAtLogin }),
    },
    settings,
  });
  handleLoginItemIpc({
    ipcMain,
    loginItem,
    isTrusted,
    openSystemSettings: () => shell.openExternal(loginItemsSettingsUrl),
  });
  handleKeepRunningIpc({ ipcMain, settings, isTrusted });
  handleFolderDialogIpc({
    ipcMain,
    isTrusted,
    windowOf: (event) => BrowserWindow.fromWebContents(event.sender),
    showOpenDialog: (window, options) =>
      window ? dialog.showOpenDialog(window, options) : dialog.showOpenDialog(options),
  });
  const menuBar = startMenuBar({ supervisor, settings, apiUrl, port, createWindow });
  try {
    await supervisor.start();
  } catch (error) {
    console.error(error);
    const problem =
      error instanceof ServerProblem
        ? error
        : error instanceof StartTimedOut
          ? serverProblem({ kind: "none" }, port)
          : undefined;
    if (problem) {
      await dialog.showMessageBox({
        type: "error",
        message: problem.message,
        detail: problem.detail,
        buttons: ["Quit"],
      });
    }
    app.quit();
    return;
  }
  onSecondLaunch(() => void menuBar.showWindow());
  const notices = requestNoticesOn(async (requestId) => {
    const window = await menuBar.showWindow();
    if (window) openRequestIn(window, requestId);
  });
  followHubFor(menuBar, notices);
  // The Dock icon or opening the app from Finder; macOS already fronts a visible window.
  app.on("activate", (_event, hasVisibleWindows) => {
    if (!hasVisibleWindows) void menuBar.showWindow();
  });
  // Opened at login, Hobbots starts in the menu bar; the menu-bar icon, the Dock or Finder opens the window.
  if (loginItem.openedAtLogin) {
    if (process.platform === "darwin") app.setActivationPolicy("accessory");
  } else {
    await menuBar.showWindow();
  }
});
