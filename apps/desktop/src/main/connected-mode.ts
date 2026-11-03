/**
 * The app as a connected desktop (ADR 025): a client of a hub on another computer, with no server,
 * no database and no installation of its own. Its window loads the hub's own pages with the device
 * token as a session cookie, its main process sends the token as a bearer token, and the token is
 * only in the keychain. Every connection first checks that the hub's address still belongs to the
 * node the user chose.
 */
import { hostname } from "node:os";
import { app, type BrowserWindow, dialog, ipcMain, Menu, powerMonitor, session, shell, Tray } from "electron";
import { newAppWindow } from "./app-window.ts";
import { connectionChannels, connectionView, handleConnectionIpc } from "./connection-ipc.ts";
import { connectionStateOf } from "./connection-state.ts";
import { type PairingOutcome, pairAsDesktop } from "./desktop-pairing.ts";
import { type Disconnected, disconnectFromHub } from "./disconnect.ts";
import {
  type ConnectionState,
  connectedHub,
  type HubOrigins,
  hubOrigins,
  isHubPage,
  makeNodeCheck,
  windowRequestGate,
} from "./hub-connection.ts";
import { followHub } from "./hub-events.ts";
import type { AppShell } from "./hub-mode.ts";
import {
  type AddressChange,
  checkNewAddress,
  followedAddress,
  type RemoteAccessChange,
  windowAfterRemoteAccess,
} from "./hub-move.ts";
import { keepsRunning } from "./keep-running.ts";
import { trayImage } from "./menu-bar.ts";
import { type ConnectedTrayModel, connectedTrayModel } from "./menu-bar-model.ts";
import { messages } from "./messages.ts";
import { CONNECTED_MODE_ARGUMENT } from "./mode-argument.ts";
import type { HubConnection } from "./settings.ts";
import { reveal } from "./single-instance.ts";
import { showOnLaunch, systemNotices } from "./system-notices.ts";
import type { DeviceTokenStore, thisComputer } from "./tailnet.ts";
import { deviceCookies, guardWindowRequests, withoutDeviceCookies } from "./window-cookies.ts";

/** How often a hub that cannot be reached is checked again (ADR 025). */
const RETRY_MS = 5000;

const copy = messages.connection;

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
const keepCookiesInMemory = (isAllowedUrl: (url: string) => boolean) =>
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    if (!isAllowedUrl(details.url) || details.responseHeaders === undefined) return callback({});
    callback({ responseHeaders: withoutDeviceCookies(details.responseHeaders) });
  });

/** Opens Tailscale on this Mac, so the user can turn it on; answers whether it opened. */
const openTailscale = async () =>
  process.platform === "darwin" && (await shell.openPath("/Applications/Tailscale.app")) === "";

/** What the user can do about the connection from the menu-bar menu and the dialog. */
interface ConnectionActions {
  readonly showWindow: () => void;
  readonly tryAgain: () => void;
}

/** The menu's items for what can be done from it: open Tailscale and try again, where the state offers them. */
const actionItems = (
  model: ConnectedTrayModel,
  actions: ConnectionActions,
): Array<Electron.MenuItemConstructorOptions> => [
  ...(model.actions.includes("openTailscale")
    ? [{ label: copy.openTailscale, click: () => void openTailscale() }]
    : []),
  ...(model.actions.includes("tryAgain") ? [{ label: copy.tryAgain, click: actions.tryAgain }] : []),
];

/** The menu-bar icon of a connected desktop: the hub's state, Open Hobbots and Quit, which stops only this app. */
const connectedMenuBar = (connection: () => HubConnection, actions: ConnectionActions) => {
  const tray = new Tray(trayImage("starting"));
  let drawn = "";
  const draw = (state: ConnectionState) => {
    const model = connectedTrayModel(state, connection());
    const key = JSON.stringify(model);
    if (key === drawn) return;
    drawn = key;
    const items = actionItems(model, actions);
    tray.setImage(trayImage(model.icon));
    tray.setToolTip(model.title);
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: model.title, sublabel: model.detail, enabled: false },
        ...(items.length > 0 ? [{ type: "separator" as const }, ...items] : []),
        { type: "separator" },
        { label: "Open Hobbots", accelerator: "CmdOrCtrl+O", click: actions.showWindow },
        { type: "separator" },
        { label: "Quit Hobbots", accelerator: "CmdOrCtrl+Q", click: () => app.quit() },
      ]),
    );
  };
  return { draw };
};

/**
 * Starts the app again after Disconnect, so it comes back with no mode at setup's first screen.
 * A hub that could not be reached still lists this computer, and the user is told so first.
 */
const startAgain = async (connection: HubConnection, stillListed: boolean) => {
  if (stillListed) {
    const copy = messages.disconnect;
    await dialog.showMessageBox({
      type: "info",
      message: copy.stillListed({ hub: connection.name }),
      detail: copy.stillListedDetail({ hub: connection.name }),
      buttons: [copy.ok],
    });
  }
  // A development start that paired from the environment would pair again at once.
  delete process.env.HOBBOTS_CONNECT_TO;
  app.relaunch();
  app.quit();
};

/**
 * Says why the hub cannot be used with no page open, in the menu bar's words, with the actions a
 * dialog can take: open Tailscale and try again. A page that is open shows the same in its banner.
 */
const explain = async (model: ConnectedTrayModel, tryAgain: () => void) => {
  const buttons = [
    ...(model.actions.includes("openTailscale")
      ? [{ label: copy.openTailscale, run: () => void openTailscale() }]
      : []),
    ...(model.actions.includes("tryAgain") ? [{ label: copy.tryAgain, run: tryAgain }] : []),
    { label: copy.ok, run: () => {} },
  ];
  const { response } = await dialog.showMessageBox({
    type: "warning",
    message: model.title,
    detail: model.detail,
    buttons: buttons.map((button) => button.label),
    defaultId: buttons.length - 1,
    cancelId: buttons.length - 1,
  });
  buttons[response]?.run();
};

/** The window's address at the same path on another origin, as when the hub moved to another port. */
const samePathOn = (url: string, origin: string) => {
  const page = new URL(url);
  return `${origin}${page.pathname}${page.search}${page.hash}`;
};

/**
 * Starts the app as a connected desktop. Called once the app is ready, with the connection the
 * settings hold; runs no server and writes no hub record to this computer. The hub's address can
 * change while it runs, on the same computer, so every reader asks for the current one.
 */
export const startConnected = async (
  { settings, loginItem, handleSettingsIpc }: AppShell,
  initial: HubConnection,
  computer: ReturnType<typeof thisComputer>,
) => {
  const originsOf = (address: string) => {
    const found = hubOrigins(address);
    if (found === undefined) throw new Error(`The stored hub address is not one Hobbots uses: ${address}`);
    return found;
  };
  let connection = initial;
  let origins = originsOf(connection.address);
  const nodeCheck = makeNodeCheck(computer.tailnet);
  const makeHub = () =>
    connectedHub({
      origins,
      nodeId: connection.nodeId,
      fallbackName: connection.nodeName,
      nodeCheck,
      nodeState: computer.tailnet.nodeState,
      token: computer.token.read,
      fetch: globalThis.fetch,
    });
  let hub = makeHub();
  const isAllowedUrl = (url: string) => isHubPage(origins, url);
  const isTrusted = (event: Electron.IpcMainInvokeEvent) => isAllowedUrl(event.senderFrame?.url ?? "");
  const connectionState = connectionStateOf({
    hub: () => hub,
    forgetNode: nodeCheck.forget,
    forgetToken: async () => {
      // The hub refuses the token anyway; one the keychain kept is removed again on Disconnect.
      await computer.token.remove().catch(() => undefined);
      await clearCookies(origins);
    },
  });
  const view = () => connectionView(connection, connectionState.current, app.getVersion(), connectionState.hubVersion);
  const tryAgain = () => void connectionState.check();

  /** Disconnects once, however often it is asked; a Disconnect that failed may be asked again. */
  let disconnecting: Promise<Disconnected> | undefined;
  const disconnect = async () => {
    try {
      const outcome = await disconnectFromHub({
        connection,
        state: () => connectionState.current,
        hub,
        token: computer.token,
        clearCookies: () => clearCookies(origins),
        settings,
      });
      // The answer reaches the page first; then the app starts again with no mode: setup's first screen.
      setImmediate(() => void startAgain(connection, outcome.stillListed));
      return outcome;
    } catch (error) {
      disconnecting = undefined;
      throw error;
    }
  };

  const windows = new Set<BrowserWindow>();
  // Each open page follows the connection, so its banner says why the hub cannot be reached.
  connectionState.onChange(() => {
    for (const window of windows) window.webContents.send(connectionChannels.changed, view());
  });

  keepCookiesInMemory(isAllowedUrl);
  // Every request of the window, reloads included, goes to the hub only while its address is the
  // pinned node's; a refused one checks the connection, which then takes the cookies away.
  guardWindowRequests(
    session.defaultSession.webRequest,
    (url) => windowRequestGate({ origins, nodeId: connection.nodeId, nodeCheck })(url),
    tryAgain,
  );
  // The window holds the token only while the hub's node checks out, and gets it back once it does.
  connectionState.onChange((state) => {
    if (state.state === "connected") void setCookies(origins, computer.token);
    else if (state.state === "otherNode") void clearCookies(origins);
  });
  // A refused request from the window's pages may mean the hub revoked this device: check now.
  session.defaultSession.webRequest.onCompleted((details) => {
    if (details.statusCode === 401 && isAllowedUrl(details.url)) tryAgain();
  });

  /** Shows the window once the hub checks out; an open page says why it cannot, otherwise a dialog does. */
  const showWindow = async (): Promise<BrowserWindow | undefined> => {
    await connectionState.check();
    const state = connectionState.current;
    const existing = [...windows][0];
    if (state.state !== "connected" && existing === undefined) {
      await explain(connectedTrayModel(state, connection), tryAgain);
      return undefined;
    }
    if (process.platform === "darwin") app.setActivationPolicy("regular");
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

  const menuBar = connectedMenuBar(() => connection, { showWindow: () => void showWindow(), tryAgain });
  connectionState.onChange(menuBar.draw);
  // Nothing runs on this computer, so the last window closing quits unless the app keeps running.
  app.on("window-all-closed", () => {
    if (!keepsRunning(settings)) app.quit();
  });

  const notices = systemNotices({ fetch: (path, init) => hub.fetchAsDevice(path, init), showWindow, settings });
  const events = followHub({
    url: () => `${origins.origin}/api/events`,
    // Each connection checks the node first; an address on another node gets no token.
    headers: () => hub.headers(),
    canConnect: () => connectionState.current.state === "connected",
    onConnected: () => {
      connectionState.set({ state: "connected", version: connectionState.hubVersion ?? "" });
      void notices.requests.check();
      void notices.devices.check();
    },
    onChange: (change) => {
      if (change._tag === "Approvals") void notices.requests.check();
      else if (change._tag === "Pairing") void notices.devices.check();
      else if (change._tag === "RemoteAccess") {
        const next = followedAddress(connection.address, change);
        if (next !== null) void moveTo(next, change);
        else followWindows(change);
      }
    },
    onLost: tryAgain,
  });
  connectionState.onChange(() => events.sync());

  /**
   * Moves to another address of the same computer (ADR 025): saved in the settings, the cookies set
   * again, the stream connected again and each page loaded again at the same path. The token stays.
   */
  /** Moves each page off the hub's HTTPS address once it stops answering, as after the hub redirected it there. */
  const followWindows = (change: RemoteAccessChange) => {
    for (const window of windows) {
      const target = windowAfterRemoteAccess(window.webContents.getURL(), connection.address, change);
      if (target !== null) void window.loadURL(target);
    }
  };

  const moveTo = async (address: string, change?: RemoteAccessChange) => {
    const before = origins;
    const next = originsOf(address);
    if (next.origin === before.origin) return;
    connection = { ...connection, address: next.origin };
    origins = next;
    hub = makeHub();
    settings.update({ connection });
    await setCookies(origins, computer.token);
    await connectionState.check();
    await events.reconnect();
    for (const window of windows) {
      const url = window.webContents.getURL();
      const target = change === undefined ? null : windowAfterRemoteAccess(url, connection.address, change);
      if (url.startsWith(`${before.origin}/`)) void window.loadURL(samePathOn(url, origins.origin));
      else if (target !== null) void window.loadURL(target);
      else window.webContents.reload();
    }
  };

  /** Takes an address the user typed after the hub moved while this app was away. */
  const changeAddress = async (typed: string): Promise<AddressChange> => {
    const snapshot = await computer.tailnet.snapshot().catch(() => null);
    if (snapshot === null) return { _tag: "Refused", message: messages.changeAddress.tailscaleOff };
    const change = await checkNewAddress({
      typed,
      nodeId: connection.nodeId,
      nodeName: connection.nodeName,
      snapshot,
      fetch: globalThis.fetch,
    });
    if (change._tag === "Moved") await moveTo(change.address);
    return change;
  };

  handleSettingsIpc(isAllowedUrl);
  handleConnectionIpc({
    ipcMain,
    isTrusted,
    view,
    retry: () => connectionState.check(),
    changeAddress,
    openTailscale,
    disconnect: () => (disconnecting ??= disconnect()),
  });

  // While the hub cannot be reached, it is checked again every 5 seconds, and at once when the Mac
  // wakes; a state only the user can change, such as a revoked device, waits for them.
  const retry = setInterval(() => {
    if (connectionState.retries) tryAgain();
  }, RETRY_MS);
  const afterWake = () => {
    nodeCheck.forget();
    tryAgain();
  };
  powerMonitor.on("resume", afterWake);
  powerMonitor.on("unlock-screen", afterWake);
  app.on("will-quit", () => {
    clearInterval(retry);
    void events.stop();
    void computer.dispose();
  });

  await connectionState.check();
  await showOnLaunch(app, loginItem, showWindow);
};
