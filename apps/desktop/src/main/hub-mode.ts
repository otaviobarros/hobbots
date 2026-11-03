import { lstat } from "node:fs/promises";
import serverPath from "@hobbots/server/main?modulePath";
import { hubPort } from "@hobbots/server/network-settings";
import { app, BrowserWindow, dialog, ipcMain, session, shell, utilityProcess } from "electron";
import { newAppWindow } from "./app-window.ts";
import { handleFolderDialogIpc } from "./folder-dialog.ts";
import { hubAddress } from "./hub-address.ts";
import { followHub } from "./hub-events.ts";
import { webClientDir } from "./local-pages.ts";
import type { LoginItem } from "./login-item.ts";
import { startMenuBar } from "./menu-bar.ts";
import { ServerSupervisor, StartTimedOut } from "./server.ts";
import { checkServer, requireOurs, ServerProblem, serverProblem } from "./server-identity.ts";
import type { SettingsStore } from "./settings.ts";
import { loginShellPath, mergePaths } from "./shell-path.ts";
import { handleShowFileIpc } from "./show-file.ts";
import { type SystemNotices, showOnLaunch, systemNotices } from "./system-notices.ts";
import { fetchAsWindow, makeWindowKey, WINDOW_COOKIE } from "./window-key.ts";

/** What the hub's app shares with a connected desktop: its settings, its login item and who may use the bridge. */
export interface AppShell {
  readonly settings: SettingsStore;
  readonly loginItem: LoginItem;
  /** Registers this app's own settings on the bridge, for pages `isAllowedUrl` accepts. */
  readonly handleSettingsIpc: (isAllowedUrl: (url: string) => boolean) => void;
}

/**
 * The app on the hub (ADR 012): it runs this installation's server, attached to or launched and
 * owned, and its window loads the hub's pages from it on this computer. Called once the app is ready,
 * or once the user chose Run here in setup, when the first window opens at `firstPage`, a route of
 * the hub's pages such as `/setup/remote`.
 */
export const startHub = async (
  { settings, loginItem, handleSettingsIpc }: AppShell,
  { firstPage }: { readonly firstPage?: string } = {},
) => {
  // The port the user chose in Settings, kept in the data folder, unless HOBBOTS_PORT overrides it.
  const hub = hubAddress(hubPort(app.getPath("userData"), process.env));
  const devWebUrl = process.env.HOBBOTS_WEB_URL ?? "http://127.0.0.1:5173";

  // A packaged app carries the web client in its resources folder; a checkout uses the web build.
  // The server serves it, and the window loads it from there like any browser on the hub (ADR 012).
  const webDir = webClientDir(app.isPackaged ? process : null, import.meta.dirname);

  /** The pages the window may show, and the only ones the preload bridge answers. */
  const isAllowedUrl = (url: string) => url.startsWith(`${devWebUrl}/`) || url.startsWith(`${hub.apiUrl}/`);

  const isUp = async (url: string) => {
    try {
      return (await fetch(url, { signal: AbortSignal.timeout(1000) })).ok;
    } catch {
      return false;
    }
  };

  /** What else follows the hub when it moves, once the app has set it up: its event stream and windows. */
  let afterMove: (before: string) => void = () => {};
  const moveHub = (port: number) => {
    const before = hub.apiUrl;
    if (hub.move(port)) afterMove(before);
  };
  /**
   * The hub saves the port it moved to before it says so, so a move this app did not hear about, such
   * as one made while its event stream was reconnecting, is found here before it looks for the hub.
   */
  const followSavedPort = () => moveHub(hubPort(app.getPath("userData"), process.env));

  /** This installation's server, attached to when it already runs or launched and owned by this app. */
  const supervisor = new ServerSupervisor({
    get apiUrl() {
      return hub.apiUrl;
    },
    probe: async () => {
      followSavedPort();
      const check = await checkServer(hub.apiUrl, app.getPath("userData"));
      if (check.kind === "none") return "none";
      requireOurs(check, hub.port);
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
          HOBBOTS_PORT: String(hub.port),
          HOBBOTS_DATA_DIR: app.getPath("userData"),
          HOBBOTS_VERSION: app.getVersion(),
          HOBBOTS_WEB_DIR: webDir,
        },
      });
      server.on("exit", (code) => console.log(`Hobbots server exited with code ${code}`));
      return server;
    },
  });

  // Only the first window opens at `firstPage`; any later one opens where the hub's pages choose.
  let route = firstPage === undefined ? "" : `#${firstPage}`;
  const createWindow = async () => {
    const window = newAppWindow({ isAllowedUrl });
    const page = route;
    route = "";
    const base = !app.isPackaged && (await isUp(devWebUrl)) ? devWebUrl : hub.apiUrl;
    await window.loadURL(`${base}/${page}`);
    return window;
  };

  /**
   * The hub's window is the one client trusted without asking (ADR 021): the hub writes a fresh window
   * key to the data folder on every start, and this app reads it. Its pages carry it as an `HttpOnly`
   * session cookie in the window's own session, for the hub's page and the Vite dev server's, so the
   * browser engine never persists it and the page never reads it. The main process sends it as a
   * bearer token.
   */
  const windowKey = makeWindowKey(app.getPath("userData"));

  const setWindowCookie = async () => {
    const value = windowKey.current();
    if (value === undefined) return;
    // The packaged app never loads the dev server, so only a dev build gives it the key.
    for (const url of app.isPackaged ? [hub.apiUrl] : [hub.apiUrl, devWebUrl]) {
      await session.defaultSession.cookies.set({
        url,
        name: WINDOW_COOKIE,
        value,
        httpOnly: true,
        sameSite: "strict",
        path: "/",
      });
    }
  };

  /** Reads the key again and sets the cookie again, as after the server restarts or answers 401. */
  const renewWindowKey = () => {
    windowKey.reload();
    void setWindowCookie();
  };

  const fetchHub = fetchAsWindow(windowKey, () => void setWindowCookie());

  /** A 401 to the window's own requests means the hub started again with a new key. */
  const renewOnRefusal = () =>
    session.defaultSession.webRequest.onCompleted({ urls: ["http://*/api/*"] }, (details) => {
      // The hub's port can change while the app runs, so the address is checked on each answer.
      const own = [hub.apiUrl, devWebUrl].some((base) => details.url.startsWith(`${base}/api/`));
      if (own && details.statusCode === 401) renewWindowKey();
    });

  /**
   * Follows the hub's event stream for the menu-bar icon and the request notifications, instead of
   * polling: they read the hub again only when the stream connects, is lost, or reports a change.
   */
  const followHubFor = (
    menuBar: Pick<ReturnType<typeof startMenuBar>, "recheck" | "activityChanged" | "remoteAccessChanged">,
    notices: SystemNotices,
  ) => {
    const events = followHub({
      url: () => `${hub.apiUrl}/api/events`,
      headers: windowKey.headers,
      canConnect: () => supervisor.mayAnswer,
      onConnected: () => {
        void menuBar.recheck();
        void notices.requests.check();
        void notices.devices.check();
      },
      onChange: (change) => {
        if (change._tag === "RemoteAccess") {
          menuBar.remoteAccessChanged(change);
          moveHub(change.port);
        } else if (change._tag === "Approvals") void notices.requests.check();
        else if (change._tag === "Pairing") void notices.devices.check();
        else void menuBar.activityChanged();
      },
      onLost: () => {
        followSavedPort();
        void menuBar.recheck();
      },
    });
    // The hub moved to another port (ADR 021): follow it there, and load each window from it again.
    afterMove = (before) => {
      void setWindowCookie();
      void events.reconnect();
      void menuBar.recheck();
      for (const window of BrowserWindow.getAllWindows()) {
        const url = window.webContents.getURL();
        if (url.startsWith(`${before}/`)) void window.loadURL(`${hub.apiUrl}${url.slice(before.length)}`);
        else window.webContents.reload();
      }
    };
    // Followed only while the server may answer; a server started again is followed at once, with
    // the key it wrote.
    supervisor.onChange(() => {
      renewWindowKey();
      events.sync();
    });
    app.on("will-quit", () => void events.stop());
  };

  handleSettingsIpc(isAllowedUrl);
  const isTrusted = (event: Electron.IpcMainInvokeEvent) => isAllowedUrl(event.senderFrame?.url ?? "");
  handleFolderDialogIpc({
    ipcMain,
    isTrusted,
    windowOf: (event) => BrowserWindow.fromWebContents(event.sender),
    showOpenDialog: (window, options) =>
      window ? dialog.showOpenDialog(window, options) : dialog.showOpenDialog(options),
  });
  handleShowFileIpc({
    ipcMain,
    isTrusted,
    readHub: async (path) => {
      const response = await fetchHub(`${hub.apiUrl}${path}`, { signal: AbortSignal.timeout(5000) });
      return response.ok ? await response.json() : null;
    },
    isFile: async (path) => (await lstat(path)).isFile(),
    showItemInFolder: (path) => shell.showItemInFolder(path),
  });
  const menuBar = startMenuBar({ supervisor, settings, hub, fetchHub, createWindow });
  try {
    await supervisor.start();
  } catch (error) {
    console.error(error);
    const problem =
      error instanceof ServerProblem
        ? error
        : error instanceof StartTimedOut
          ? serverProblem({ kind: "none" }, hub.port)
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
  // The server answers now, so its window key is in the data folder.
  windowKey.reload();
  await setWindowCookie();
  renewOnRefusal();
  const notices = systemNotices({
    fetch: (path, init) => fetchHub(`${hub.apiUrl}${path}`, init),
    showWindow: menuBar.showWindow,
    settings,
  });
  followHubFor(menuBar, notices);
  await showOnLaunch(app, loginItem, menuBar.showWindow);
};
