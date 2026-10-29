import { join, resolve } from "node:path";
import serverPath from "@hobbots/server/main?modulePath";
import { app, BrowserWindow, dialog, ipcMain, shell, type UtilityProcess, utilityProcess } from "electron";
import { handleLoginItemIpc, loginItemsSettingsUrl, makeLoginItem } from "./login-item.ts";
import { checkServer, requireOurs, ServerProblem, waitForServer } from "./server-identity.ts";
import { fileSettingsStore } from "./settings.ts";
import { loginShellPath, mergePaths } from "./shell-path.ts";
import { claimSingleInstance, onSecondLaunch, reveal } from "./single-instance.ts";

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
  credits: "Free and open-source software under the Apache License 2.0. See hobbots.ai.",
});

const port = Number(process.env.HOBBOTS_PORT ?? 4317);
const apiUrl = `http://127.0.0.1:${port}`;
const devWebUrl = process.env.HOBBOTS_WEB_URL ?? "http://localhost:5173";

// A packaged app carries the web client in its resources folder; a checkout uses the web build.
// The server serves it, and the window loads it from there like any browser on the hub (ADR 012).
const webDir = app.isPackaged ? join(process.resourcesPath, "web") : resolve(import.meta.dirname, "../../../web/dist");

let server: UtilityProcess | null = null;

/** The pages the window may show, and the only ones the preload bridge answers. */
const isAllowedUrl = (url: string) => url.startsWith(`${devWebUrl}/`) || url.startsWith(`${apiUrl}/`);

const isUp = async (url: string) => {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(1000) })).ok;
  } catch {
    return false;
  }
};

/** Connects to this installation's running server, or launches one owned by this app. */
const ensureServer = async () => {
  const dataDir = app.getPath("userData");
  const running = await checkServer(apiUrl, dataDir);
  if (running.kind !== "none") return requireOurs(running, port);
  // A packaged app is opened from Finder or the Dock, without the shell's PATH.
  const path = app.isPackaged ? mergePaths(await loginShellPath(), process.env.PATH) : process.env.PATH;
  server = utilityProcess.fork(serverPath, [], {
    serviceName: "Hobbots Server",
    stdio: "inherit",
    env: {
      ...process.env,
      PATH: path,
      HOBBOTS_PORT: String(port),
      HOBBOTS_DATA_DIR: dataDir,
      HOBBOTS_VERSION: app.getVersion(),
      HOBBOTS_WEB_DIR: webDir,
    },
  });
  server.on("exit", (code) => {
    console.log(`Hobbots server exited with code ${code}`);
    server = null;
  });
  requireOurs(await waitForServer(apiUrl, dataDir, 20_000), port);
};

const createWindow = async () => {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 610,
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
};

/** Shows the existing window, or opens one when there is none. */
const showWindow = () => {
  const [existing] = BrowserWindow.getAllWindows();
  if (existing) reveal(existing);
  else void createWindow();
};

app.whenReady().then(async () => {
  if (!primary) return;
  // Only the installed app registers, so a checkout never adds Electron itself as a login item.
  const loginItem = makeLoginItem({
    supported: app.isPackaged && process.platform === "darwin",
    items: {
      read: () => app.getLoginItemSettings(),
      write: (openAtLogin) => app.setLoginItemSettings({ openAtLogin }),
    },
    settings: fileSettingsStore(join(app.getPath("userData"), "desktop-settings.json")),
  });
  handleLoginItemIpc({
    ipcMain,
    loginItem,
    isTrusted: (event) => isAllowedUrl(event.senderFrame?.url ?? ""),
    openSystemSettings: () => shell.openExternal(loginItemsSettingsUrl),
  });
  try {
    await ensureServer();
    // Opened at login, Hobbots starts in the background; the Dock or Finder opens the window.
    if (!loginItem.openedAtLogin) await createWindow();
  } catch (error) {
    console.error(error);
    if (error instanceof ServerProblem) {
      await dialog.showMessageBox({ type: "error", message: error.message, detail: error.detail, buttons: ["Quit"] });
    }
    app.quit();
    return;
  }
  onSecondLaunch(showWindow);
  // The Dock icon or opening the app from Finder; macOS already fronts a visible window.
  app.on("activate", (_event, hasVisibleWindows) => {
    if (!hasVisibleWindows) showWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// A server this app launched stops with it; a server started separately keeps running.
app.on("before-quit", () => {
  server?.kill();
});
