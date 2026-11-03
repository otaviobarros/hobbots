/**
 * The app before this computer is anything for Hobbots (ADR 025): no server, no database and no
 * installation ID. Its window shows the local pages, Welcome and Where Hobbots runs, from the app's
 * own resources. Run here makes it the hub; Connect makes it a connected desktop once the hub allowed
 * it. Either way the next mode's own window takes over from setup's.
 */
import { pathToFileURL } from "node:url";
import type { ConnectEnd } from "@hobbots/api";
import { app, type BrowserWindow, ipcMain, net, protocol } from "electron";
import { chooseMode } from "./app-mode.ts";
import { newAppWindow } from "./app-window.ts";
import { connectToHub, listHubs } from "./connect-flow.ts";
import type { AppShell } from "./hub-mode.ts";
import { isLocalPage, LOCAL_ENTRY, LOCAL_ORIGIN, LOCAL_SCHEME, localFile, webClientDir } from "./local-pages.ts";
import { SETUP_MODE_ARGUMENT } from "./mode-argument.ts";
import type { HubConnection } from "./settings.ts";
import { handleSetupIpc } from "./setup-ipc.ts";
import { onSecondLaunch, reveal } from "./single-instance.ts";
import type { thisComputer } from "./tailnet.ts";

/**
 * Registers the local pages' scheme as standard and secure, so they get their own origin and
 * root-relative assets. Must run before the app is ready.
 */
export const registerLocalScheme = () =>
  protocol.registerSchemesAsPrivileged([
    { scheme: LOCAL_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
  ]);

/** What setup hands over to once the user chose. */
export interface SetupNext {
  /** Starts this computer as the hub, its window at `firstPage`. */
  readonly startHub: (firstPage: string) => Promise<void>;
  /** Starts this computer as a connected desktop of the hub that allowed it. */
  readonly startConnected: (connection: HubConnection) => Promise<void>;
}

const isUp = async (url: string) => {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(1000) })).ok;
  } catch {
    return false;
  }
};

/**
 * Starts setup: serves the local pages, opens setup's window and answers its calls. Called once the
 * app is ready, on a computer that chose nothing yet.
 */
export const startSetup = async (
  { settings }: AppShell,
  computer: () => ReturnType<typeof thisComputer>,
  next: SetupNext,
  { start = "welcome" }: { readonly start?: "welcome" | "where" } = {},
) => {
  // In development the local pages come from the Vite dev server, like the rest of the client.
  const devWebUrl = process.env.HOBBOTS_WEB_URL ?? "http://127.0.0.1:5173";
  const fromDevServer = !app.isPackaged && (await isUp(`${devWebUrl}/${LOCAL_ENTRY}`));
  const webDir = webClientDir(app.isPackaged ? process : null, import.meta.dirname);
  protocol.handle(LOCAL_SCHEME, async (request) => {
    const file = localFile(webDir, request.url);
    if (file === null) return new Response("Not found", { status: 404 });
    try {
      return await net.fetch(pathToFileURL(file).toString());
    } catch {
      return new Response("Not found", { status: 404 });
    }
  });

  const isAllowedUrl = (url: string) => isLocalPage(url, fromDevServer ? devWebUrl : null);
  // Until the user chose, closing setup's window quits: nothing runs on this computer yet.
  let choosing = true;
  let window: BrowserWindow | undefined;
  let pairing: AbortController | undefined;

  /** Hands over to the mode the user chose; setup's window closes once the next one is up. */
  const handOver = async (start: () => Promise<void>) => {
    choosing = false;
    stopAnswering();
    await start();
    window?.destroy();
  };

  const stopAnswering = handleSetupIpc({
    ipcMain,
    isTrusted: (event) => isAllowedUrl(event.senderFrame?.url ?? ""),
    setup: {
      runHere: () => {
        // Run here ends any Connect still under way, so an Allow that comes later chooses nothing.
        pairing?.abort();
        return handOver(() => {
          chooseMode(settings, { mode: "hub" });
          return next.startHub("/setup/remote");
        });
      },
      findHubs: () => listHubs(computer().tailnet),
      connect: async (typed, onWaiting): Promise<ConnectEnd> => {
        if (!choosing) return { kind: "cancelled" };
        pairing?.abort();
        const controller = new AbortController();
        pairing = controller;
        const end = await connectToHub(typed, {
          tailnet: computer().tailnet,
          fetch: globalThis.fetch,
          keepToken: computer().token.write,
          forgetToken: computer().token.remove,
          onWaiting,
          // It becomes a connected desktop only once the hub allowed it and the token is in the keychain.
          onAllowed: async (connection) => {
            chooseMode(settings, { mode: "connected", connection });
            void handOver(() => next.startConnected(connection));
          },
          signal: controller.signal,
        });
        if (pairing === controller) pairing = undefined;
        return end;
      },
      cancel: () => pairing?.abort(),
    },
  });

  app.on("window-all-closed", () => {
    if (choosing) app.quit();
  });
  onSecondLaunch(() => {
    if (choosing && window !== undefined) reveal(window);
  });
  app.on("will-quit", () => pairing?.abort());

  window = newAppWindow({ isAllowedUrl, additionalArguments: [SETUP_MODE_ARGUMENT] });
  const query = start === "where" ? "?start=where" : "";
  await window.loadURL(fromDevServer ? `${devWebUrl}/${LOCAL_ENTRY}${query}` : `${LOCAL_ORIGIN}/${query}`);
  reveal(window);
};
