import { desktopMode, type HubConnection, type SettingsStore } from "./settings.ts";

/** How the app starts (ADR 025): as the hub, as a connected desktop, or pairing with a hub first. */
export type Start =
  | { readonly start: "hub" }
  | { readonly start: "connected"; readonly connection: HubConnection }
  | { readonly start: "pair"; readonly address: string };

/**
 * Decides how the app starts from the mode in its settings. A data folder that already holds an
 * installation ID is a hub: the mode is written on its first start and never asked. A connected
 * desktop starts no server, whatever else is in its data folder. Until Welcome, Where Hobbots runs
 * and Connect are built (#446), a computer that chose nothing pairs with `connectTo` when given and
 * otherwise starts as a hub without saving that choice.
 */
export const startMode = (
  settings: SettingsStore,
  {
    installationId,
    connectTo,
  }: { readonly installationId: string | undefined; readonly connectTo?: string | undefined },
): Start => {
  const chosen = desktopMode(settings.read());
  if (chosen?.mode === "connected") return { start: "connected", connection: chosen.connection };
  if (chosen?.mode === "hub") return { start: "hub" };
  if (installationId !== undefined) {
    settings.update({ mode: "hub" });
    return { start: "hub" };
  }
  return connectTo ? { start: "pair", address: connectTo } : { start: "hub" };
};
