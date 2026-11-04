import { join } from "node:path";
import { readInstallationId } from "@hobbots/server/installation";
import { app, BrowserWindow, ipcMain, shell } from "electron";
import { startMode } from "./app-mode.ts";
import { startConnected } from "./connected-mode.ts";
import { startHub } from "./hub-mode.ts";
import { handleKeepRunningIpc } from "./keep-running.ts";
import { handleLoginItemIpc, loginItemsSettingsUrl, makeLoginItem } from "./login-item.ts";
import { handleNotificationIpc } from "./notification-choices.ts";
import { fileSettingsStore } from "./settings.ts";
import { registerLocalScheme, startSetup } from "./setup-mode.ts";
import { claimSingleInstance } from "./single-instance.ts";
import { thisComputer } from "./tailnet.ts";
import { handleWindowBackgroundIpc } from "./window-background.ts";

// Same name as the server's default data folder, so `pnpm dev` and the app share one installation.
app.setName("Hobbots");

// Setup's local pages have their own scheme, which must be known before the app is ready (ADR 025).
registerLocalScheme();

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

app.whenReady().then(async () => {
  if (!primary) return;
  const dataDir = app.getPath("userData");
  const settings = fileSettingsStore(join(dataDir, "desktop-settings.json"));
  // Only the installed app registers, so a checkout never adds Electron itself as a login item.
  const loginItem = makeLoginItem({
    supported: app.isPackaged && process.platform === "darwin",
    items: {
      read: () => app.getLoginItemSettings(),
      write: (openAtLogin) => app.setLoginItemSettings({ openAtLogin }),
    },
    settings,
  });
  const appShell = {
    settings,
    loginItem,
    handleSettingsIpc: (isAllowedUrl: (url: string) => boolean) => {
      const isTrusted = (event: Electron.IpcMainInvokeEvent) => isAllowedUrl(event.senderFrame?.url ?? "");
      handleLoginItemIpc({
        ipcMain,
        loginItem,
        isTrusted,
        openSystemSettings: () => shell.openExternal(loginItemsSettingsUrl),
      });
      handleKeepRunningIpc({ ipcMain, settings, isTrusted });
      handleNotificationIpc({ ipcMain, settings, isTrusted });
      handleWindowBackgroundIpc({
        ipcMain,
        settings,
        isTrusted,
        windowOf: (event) => BrowserWindow.fromWebContents(event.sender),
      });
    },
  };

  // This computer's Tailscale and keychain, read only once the app is or becomes a connected desktop.
  let tailnet: ReturnType<typeof thisComputer> | undefined;
  const computer = () => (tailnet ??= thisComputer({ dataDir, env: process.env, platform: process.platform }));

  const start = startMode(settings, {
    installationId: readInstallationId(dataDir),
    // Scripts that test the hub on a new data folder start it as Run here would.
    asHub: process.env.HOBBOTS_MODE === "hub",
  });
  if (start.start === "setup") {
    // Welcome and Where Hobbots runs, with no server until the user chose Run here.
    await startSetup(
      appShell,
      computer,
      {
        startHub: (firstPage) => startHub(appShell, { firstPage }),
        startConnected: (connection) => startConnected(appShell, connection, computer()),
      },
      { start: start.page },
    );
  } else if (start.start === "connected") {
    // No server, no database, no installation ID and no network settings on this computer.
    await startConnected(appShell, start.connection, computer());
  } else {
    await startHub(appShell);
  }
});
