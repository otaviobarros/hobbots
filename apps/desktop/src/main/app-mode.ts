import { desktopMode, type HubConnection, type SettingsStore } from "./settings.ts";

/** How the app starts (ADR 025): as the hub, as a connected desktop, or with setup's local pages. */
export type Start =
  | { readonly start: "hub" }
  | { readonly start: "connected"; readonly connection: HubConnection }
  /** Welcome first on a new computer; Where Hobbots runs after Disconnect, since it used Hobbots already. */
  | { readonly start: "setup"; readonly page: "welcome" | "where" };

/**
 * Decides how the app starts from the mode in its settings. A data folder that already holds an
 * installation ID is a hub: the mode is written on its first start and never asked. A connected
 * desktop starts no server, whatever else is in its data folder. A computer that chose nothing starts
 * setup, with no server, unless `asHub` makes it the hub as Run here would, for scripts that test the
 * hub on a new data folder. One that left a hub with Disconnect starts setup at Where Hobbots runs and
 * never becomes a hub by itself, since a hub's server writes an installation ID and stays a hub.
 */
export const startMode = (
  settings: SettingsStore,
  { installationId, asHub = false }: { readonly installationId: string | undefined; readonly asHub?: boolean },
): Start => {
  const chosen = desktopMode(settings.read());
  if (chosen?.mode === "connected") return { start: "connected", connection: chosen.connection };
  if (chosen?.mode === "hub") return { start: "hub" };
  if (installationId !== undefined || asHub) {
    settings.update({ mode: "hub" });
    return { start: "hub" };
  }
  return { start: "setup", page: settings.read().leftHub === true ? "where" : "welcome" };
};

/** Keeps the mode the user chose in setup, and forgets that it left a hub, so it is never asked again. */
export const chooseMode = (
  settings: SettingsStore,
  chosen: { readonly mode: "hub" } | { readonly mode: "connected"; readonly connection: HubConnection },
): void => {
  settings.update({ ...chosen, leftHub: undefined });
};
