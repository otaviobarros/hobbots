import { join, resolve } from "node:path";
import serverPath from "@hobbots/server/main?modulePath";
import { app, BrowserWindow, shell, type UtilityProcess, utilityProcess } from "electron";
import { loginShellPath, mergePaths } from "./shell-path.ts";

// Same name as the server's default data folder, so `pnpm dev` and the app share one installation.
app.setName("Hobbots");

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

const isUp = async (url: string) => {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(1000) })).ok;
  } catch {
    return false;
  }
};

const waitUntilUp = async (url: string, timeoutMs: number) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isUp(url)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
};

/** Connects to a running server, or launches one owned by this app. */
const ensureServer = async () => {
  if (await isUp(`${apiUrl}/api/health`)) return;
  // A packaged app is opened from Finder or the Dock, without the shell's PATH.
  const path = app.isPackaged ? mergePaths(await loginShellPath(), process.env.PATH) : process.env.PATH;
  server = utilityProcess.fork(serverPath, [], {
    serviceName: "Hobbots Server",
    stdio: "inherit",
    env: {
      ...process.env,
      PATH: path,
      HOBBOTS_PORT: String(port),
      HOBBOTS_DATA_DIR: app.getPath("userData"),
      HOBBOTS_WEB_DIR: webDir,
    },
  });
  server.on("exit", (code) => {
    console.log(`Hobbots server exited with code ${code}`);
    server = null;
  });
  if (!(await waitUntilUp(`${apiUrl}/api/health`, 20_000))) {
    throw new Error(`The Hobbots server did not start on ${apiUrl}`);
  }
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
    if (!url.startsWith(`${devWebUrl}/`) && !url.startsWith(`${apiUrl}/`)) event.preventDefault();
  });

  if (!app.isPackaged && (await isUp(devWebUrl))) {
    await window.loadURL(devWebUrl);
  } else {
    await window.loadURL(`${apiUrl}/`);
  }
};

app.whenReady().then(async () => {
  try {
    await ensureServer();
    await createWindow();
  } catch (error) {
    console.error(error);
    app.quit();
  }
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// A server this app launched stops with it; a server started separately keeps running.
app.on("before-quit", () => {
  server?.kill();
});
