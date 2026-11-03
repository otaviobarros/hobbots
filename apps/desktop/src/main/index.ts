import { join } from "node:path";
import { readInstallationId } from "@hobbots/server/installation";
import { app, dialog, ipcMain, shell } from "electron";
import { startMode } from "./app-mode.ts";
import { pairWith, startConnected } from "./connected-mode.ts";
import { startHub } from "./hub-mode.ts";
import { handleKeepRunningIpc } from "./keep-running.ts";
import { handleLoginItemIpc, loginItemsSettingsUrl, makeLoginItem } from "./login-item.ts";
import { messages } from "./messages.ts";
import { handleNotificationIpc } from "./notification-choices.ts";
import { fileSettingsStore } from "./settings.ts";
import { claimSingleInstance } from "./single-instance.ts";
import { thisComputer } from "./tailnet.ts";

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
    },
  };

  // This computer's Tailscale and keychain, read only once the app is or becomes a connected desktop.
  let tailnet: ReturnType<typeof thisComputer> | undefined;
  const computer = () => (tailnet ??= thisComputer({ dataDir, env: process.env, platform: process.platform }));

  const start = startMode(settings, {
    installationId: readInstallationId(dataDir),
    connectTo: process.env.HOBBOTS_CONNECT_TO,
  });
  if (start.start === "pair") {
    // It becomes a connected desktop only once the hub allowed it.
    const outcome = await pairWith(start.address, computer());
    if (outcome.kind !== "allowed") {
      console.error(`Hobbots did not connect to ${start.address}: ${outcome.kind}`);
      await computer().dispose();
      app.quit();
      return;
    }
    settings.update({ mode: "connected", connection: outcome.connection, leftHub: undefined });
    await startConnected(appShell, outcome.connection, computer());
  } else if (start.start === "choose") {
    // Until setup's own first screen runs without a hub (#446), this computer is asked here, so a
    // disconnected Mac never becomes a hub by itself.
    const copy = messages.choose;
    const { response } = await dialog.showMessageBox({
      type: "question",
      message: copy.title,
      detail: copy.detail,
      buttons: [copy.runHere, copy.quit],
      defaultId: 0,
      cancelId: 1,
    });
    if (response !== 0) {
      app.quit();
      return;
    }
    settings.update({ leftHub: undefined });
    await startHub(appShell);
  } else if (start.start === "connected") {
    // No server, no database, no installation ID and no network settings on this computer.
    await startConnected(appShell, start.connection, computer());
  } else {
    await startHub(appShell);
  }
});
