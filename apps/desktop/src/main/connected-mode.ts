/**
 * The app as a connected desktop (ADR 025): a client of a hub on another computer, with no server,
 * no database and no installation of its own. Its window loads the hub's own pages with the device
 * token as a session cookie, its main process sends the token as a bearer token, and the token is
 * only in the keychain. Every connection first checks that the hub's address still belongs to the
 * node the user chose.
 */
import { hostname } from "node:os";
import { app, type BrowserWindow, dialog, ipcMain, Menu, session, Tray } from "electron";
import { newAppWindow } from "./app-window.ts";
import { coalesce } from "./coalesce.ts";
import { connectionView, handleConnectionIpc } from "./connection-ipc.ts";
import { type PairingOutcome, pairAsDesktop } from "./desktop-pairing.ts";
import {
  type ConnectedHub,
  type ConnectionState,
  connectedHub,
  type HubOrigins,
  hubOrigins,
  isHubPage,
  makeNodeCheck,
} from "./hub-connection.ts";
import { followHub } from "./hub-events.ts";
import type { AppShell } from "./hub-mode.ts";
import { keepsRunning } from "./keep-running.ts";
import { trayImage } from "./menu-bar.ts";
import { connectedTrayModel } from "./menu-bar-model.ts";
import { CONNECTED_MODE_ARGUMENT } from "./mode-argument.ts";
import type { HubConnection } from "./settings.ts";
import { reveal } from "./single-instance.ts";
import { showOnLaunch, systemNotices } from "./system-notices.ts";
import type { DeviceTokenStore, thisComputer } from "./tailnet.ts";
import { deviceCookies, withoutDeviceCookies } from "./window-cookies.ts";

/** How often a hub that cannot be reached is checked again (ADR 025). */
const RETRY_MS = 5000;

/** What the hub's prompt calls this computer, as the hub's own window names its own. */
const deviceName = () => `Hobbots on ${hostname().replace(/\.local$/i, "")}`;
const platformName = () => (process.platform === "darwin" ? "macOS" : process.platform);

/**
 * Pairs with the hub at `address` until #446 builds Connect: the waiting text, with the computer as
 * Tailscale names it and the code the hub's prompt shows, goes to the app's log.
 */
export const pairWith = async (address: string, computer: ReturnType<typeof thisComputer>): Promise<PairingOutcome> => {
  const origins = hubOrigins(address);
  if (origins === undefined) return { kind: "notYourNode" };
  return pairAsDesktop({
    origins,
    device: { name: deviceName(), platform: platformName() },
    nodeCheck: makeNodeCheck(computer.tailnet),
    ownLogin: await computer.tailnet.ownLogin(),
    fetch: globalThis.fetch,
    keepToken: computer.token.write,
    onWaiting: ({ node, hubName, code }) =>
      console.log(
        `Approve this Mac on ${node.nodeName} (${hubName}). You should see a prompt with this code there: ${code}`,
      ),
  });
};

/** Removes both device cookies from the window's session, as after the hub revoked this device. */
const clearCookies = async (origins: HubOrigins) => {
  for (const cookie of deviceCookies(origins, "")) await session.defaultSession.cookies.remove(cookie.url, cookie.name);
};

/** Sets both device cookies from the keychain, before any page of the hub loads. */
const setCookies = async (origins: HubOrigins, token: DeviceTokenStore) => {
  const value = await token.read();
  if (value === undefined) return clearCookies(origins);
  for (const cookie of deviceCookies(origins, value)) await session.defaultSession.cookies.set(cookie);
};

/**
 * Keeps the hub's refresh of the device cookie, with its 400-day lifetime, out of the window's cookie
 * store: only the main process sets it, as a session cookie. Every other header passes untouched.
 */
const keepCookiesInMemory = (origins: HubOrigins) =>
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    if (!isHubPage(origins, details.url) || details.responseHeaders === undefined) return callback({});
    callback({ responseHeaders: withoutDeviceCookies(details.responseHeaders) });
  });

/** The menu-bar icon of a connected desktop: the hub's state, Open Hobbots and Quit, which stops only this app. */
const connectedMenuBar = (connection: HubConnection, showWindow: () => void) => {
  const tray = new Tray(trayImage("starting"));
  let drawn = "";
  const draw = (state: ConnectionState) => {
    const model = connectedTrayModel(state, connection);
    const key = JSON.stringify(model);
    if (key === drawn) return;
    drawn = key;
    tray.setImage(trayImage(model.icon));
    tray.setToolTip(model.title);
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: model.title, sublabel: model.detail, enabled: false },
        { type: "separator" },
        { label: "Open Hobbots", accelerator: "CmdOrCtrl+O", click: showWindow },
        { type: "separator" },
        { label: "Quit Hobbots", accelerator: "CmdOrCtrl+Q", click: () => app.quit() },
      ]),
    );
  };
  return { draw };
};

/** Where the connection stands, and what follows from each change of it. */
const connectionStateOf = (hub: ConnectedHub, token: DeviceTokenStore, origins: HubOrigins) => {
  let state: ConnectionState = { state: "connecting" };
  let hubVersion: string | null = null;
  const listeners = new Set<(state: ConnectionState) => void>();
  const set = (next: ConnectionState) => {
    state = next;
    if (next.state === "connected") hubVersion = next.version;
    for (const listener of listeners) listener(next);
  };
  /**
   * Checks the node and the hub again; a hub that no longer knows this device forgets its token.
   * Checks never overlap, and a device the hub refused stays refused until the user acts (#448).
   */
  const check = coalesce(async () => {
    if (state.state === "revoked" || state.state === "unknownDevice") return;
    const refusal = state.state === "connected" ? await hub.refusal() : null;
    if (refusal !== null) {
      await token.remove();
      await clearCookies(origins);
      return set({ state: refusal });
    }
    set(await hub.verify());
  });
  return {
    get current() {
      return state;
    },
    get hubVersion() {
      return hubVersion;
    },
    set,
    check,
    onChange: (listener: (state: ConnectionState) => void) => void listeners.add(listener),
  };
};

/**
 * Starts the app as a connected desktop. Called once the app is ready, with the connection the
 * settings hold; runs no server and writes no hub record to this computer.
 */
export const startConnected = async (
  { settings, loginItem, handleSettingsIpc }: AppShell,
  connection: HubConnection,
  computer: ReturnType<typeof thisComputer>,
) => {
  const origins = hubOrigins(connection.address);
  if (origins === undefined) throw new Error(`The stored hub address is not one Hobbots uses: ${connection.address}`);
  const isAllowedUrl = (url: string) => isHubPage(origins, url);
  const isTrusted = (event: Electron.IpcMainInvokeEvent) => isAllowedUrl(event.senderFrame?.url ?? "");
  const hub = connectedHub({
    origins,
    nodeId: connection.nodeId,
    fallbackName: connection.nodeName,
    nodeCheck: makeNodeCheck(computer.tailnet),
    token: computer.token.read,
    fetch: globalThis.fetch,
  });
  const connectionState = connectionStateOf(hub, computer.token, origins);

  handleSettingsIpc(isAllowedUrl);
  handleConnectionIpc({
    ipcMain,
    isTrusted,
    view: () => connectionView(connection, connectionState.current, app.getVersion(), connectionState.hubVersion),
  });
  keepCookiesInMemory(origins);
  // A refused request from the window's pages may mean the hub revoked this device: check now.
  session.defaultSession.webRequest.onCompleted((details) => {
    if (details.statusCode === 401 && isAllowedUrl(details.url)) void connectionState.check();
  });

  const windows = new Set<BrowserWindow>();
  /** Shows the window once the hub checks out; otherwise says why it cannot, from the menu bar's words. */
  const showWindow = async (): Promise<BrowserWindow | undefined> => {
    await connectionState.check();
    const state = connectionState.current;
    if (state.state !== "connected") {
      const model = connectedTrayModel(state, connection);
      await dialog.showMessageBox({ type: "warning", message: model.title, detail: model.detail, buttons: ["OK"] });
      return undefined;
    }
    if (process.platform === "darwin") app.setActivationPolicy("regular");
    const existing = [...windows][0];
    if (existing) {
      reveal(existing);
      return existing;
    }
    await setCookies(origins, computer.token);
    const window = newAppWindow({ isAllowedUrl, additionalArguments: [CONNECTED_MODE_ARGUMENT] });
    windows.add(window);
    window.on("closed", () => {
      windows.delete(window);
      if (windows.size === 0 && process.platform === "darwin") app.setActivationPolicy("accessory");
    });
    await window.loadURL(`${origins.origin}/`);
    reveal(window);
    return window;
  };

  const menuBar = connectedMenuBar(connection, () => void showWindow());
  connectionState.onChange(menuBar.draw);
  // Nothing runs on this computer, so the last window closing quits unless the app keeps running.
  app.on("window-all-closed", () => {
    if (!keepsRunning(settings)) app.quit();
  });

  const notices = systemNotices({ fetch: hub.fetchAsDevice, showWindow, settings });
  const events = followHub({
    url: () => `${origins.origin}/api/events`,
    // Each connection checks the node first; an address on another node gets no token.
    headers: hub.headers,
    canConnect: () => connectionState.current.state === "connected",
    onConnected: () => {
      connectionState.set({ state: "connected", version: connectionState.hubVersion ?? "" });
      void notices.requests.check();
      void notices.devices.check();
    },
    onChange: (change) => {
      if (change._tag === "Approvals") void notices.requests.check();
      else if (change._tag === "Pairing") void notices.devices.check();
    },
    onLost: () => void connectionState.check(),
  });
  connectionState.onChange(() => events.sync());
  // While the hub cannot be reached, it is checked again every 5 seconds; a state only the user can
  // change, such as a revoked device, waits for them.
  const waitsForUser = new Set<ConnectionState["state"]>(["connected", "noToken", "revoked", "unknownDevice"]);
  const retry = setInterval(() => {
    if (!waitsForUser.has(connectionState.current.state)) void connectionState.check();
  }, RETRY_MS);
  app.on("will-quit", () => {
    clearInterval(retry);
    void events.stop();
    void computer.dispose();
  });

  await connectionState.check();
  await showOnLaunch(app, loginItem, showWindow);
};
