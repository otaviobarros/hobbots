import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { messages } from "./messages.ts";

/**
 * The hub a connected desktop uses (ADR 025). None of it is a secret: the device token is only in
 * the keychain.
 */
export interface HubConnection {
  /** The hub's address: `http://<MagicDNS name>:<port>` or `https://<MagicDNS name>`. */
  readonly address: string;
  /** The hub's name as its health endpoint gave it. */
  readonly name: string;
  /** The stable ID Tailscale gives the hub's computer, which every connection checks first. */
  readonly nodeId: string;
  /** The hub's Tailscale node name, which names the computer wherever the app shows it. */
  readonly nodeName: string;
  /** This computer's device on the hub, so it can revoke itself on Disconnect. */
  readonly deviceId: string;
}

/**
 * What this computer is for Hobbots (ADR 025): the hub, or connected to a hub. Absent while the user
 * has not chosen.
 */
export type DesktopMode = { readonly mode: "hub" } | { readonly mode: "connected"; readonly connection: HubConnection };

/**
 * Choices that belong to this Mac rather than to the hub, such as whether Hobbots opens at login
 * or keeps running in the menu bar.
 * A setting that was never chosen is absent, so each one keeps its own default.
 */
interface DesktopSettings {
  readonly openAtLogin?: boolean;
  /** Closing the last window keeps the app, the server and running work alive (ADR 012). */
  readonly keepRunningInMenuBar?: boolean;
  /** Which system notifications the app sends, each on until the user turns it off. */
  readonly notifyRequests?: boolean;
  readonly notifyDevices?: boolean;
  readonly notifySound?: boolean;
  readonly mode?: DesktopMode["mode"] | undefined;
  readonly connection?: HubConnection | undefined;
  /** Set by Disconnect: this computer left a hub and has not chosen again, so it must not become a hub by itself. */
  readonly leftHub?: boolean | undefined;
  /** The theme's ground the page last reported, which a new window opens with. */
  readonly windowBackground?: string | undefined;
}

export interface SettingsStore {
  readonly read: () => DesktopSettings;
  /** Merges `patch` into the settings and saves them in the background; a key set to undefined is removed. */
  readonly update: (patch: DesktopSettings) => DesktopSettings;
  /**
   * Resolves once every update made so far is on disk, as before the app quits or starts again, and
   * rejects when the latest save failed, so a caller never reports a change the file does not hold.
   */
  readonly saved: () => Promise<void>;
}

const CONNECTION_KEYS = ["address", "name", "nodeId", "nodeName", "deviceId"] as const satisfies ReadonlyArray<
  keyof HubConnection
>;

const parseConnection = (value: unknown): HubConnection | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (!CONNECTION_KEYS.every((key) => typeof record[key] === "string" && record[key] !== "")) return undefined;
  return Object.fromEntries(CONNECTION_KEYS.map((key) => [key, record[key]])) as unknown as HubConnection;
};

/** The mode the settings hold: a connected mode without a whole connection counts as none chosen. */
export const desktopMode = (settings: DesktopSettings): DesktopMode | undefined => {
  if (settings.mode === "hub") return { mode: "hub" };
  if (settings.mode === "connected" && settings.connection !== undefined) {
    return { mode: "connected", connection: settings.connection };
  }
  return undefined;
};

const BOOLEAN_KEYS = [
  "openAtLogin",
  "keepRunningInMenuBar",
  "notifyRequests",
  "notifyDevices",
  "notifySound",
  "leftHub",
] as const satisfies ReadonlyArray<keyof DesktopSettings>;

const parse = (raw: string): DesktopSettings => {
  const value: unknown = JSON.parse(raw);
  if (typeof value !== "object" || value === null) return {};
  const record = value as Record<string, unknown>;
  const connection = parseConnection(record.connection);
  return {
    ...Object.fromEntries(
      BOOLEAN_KEYS.flatMap((key) => (typeof record[key] === "boolean" ? [[key, record[key]]] : [])),
    ),
    ...((record.mode === "hub" || record.mode === "connected") && { mode: record.mode }),
    ...(connection !== undefined && { connection }),
    ...(typeof record.windowBackground === "string" && { windowBackground: record.windowBackground }),
  };
};

/** The settings as the file holds them; a missing or unreadable file reads as no choices made. */
const load = (file: string): DesktopSettings => {
  try {
    // standards-allow STD-DESKTOP-008: read once when the app starts, before any window opens
    return parse(readFileSync(file, "utf8"));
  } catch {
    return {};
  }
};

/** Written beside the file and renamed over it, so a crash never leaves half a file. */
const save = async (file: string, settings: DesktopSettings) => {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(`${file}.tmp`, `${JSON.stringify(settings, null, 2)}\n`);
  await rename(`${file}.tmp`, file);
};

const withoutUnset = (settings: DesktopSettings): DesktopSettings =>
  Object.fromEntries(Object.entries(settings).filter(([, value]) => value !== undefined));

/**
 * A small JSON file in the app's data folder, read once when the store is made and kept in memory
 * after that. The app is its only writer, so each update changes the copy in memory at once and is
 * saved without blocking the main process (STD-DESKTOP-008), one save after another in order. Each
 * save writes every setting, so the latest one decides whether the file holds them all.
 */
export const fileSettingsStore = (file: string, write: typeof save = save): SettingsStore => {
  let current = load(file);
  let saving: Promise<void> = Promise.resolve();
  return {
    read: () => current,
    update: (patch) => {
      const next = withoutUnset({ ...current, ...patch });
      current = next;
      saving = saving.catch(() => undefined).then(() => write(file, next));
      saving.catch((error: unknown) => console.error("Hobbots could not save its desktop settings", error));
      return next;
    },
    saved: () => saving,
  };
};

/**
 * Waits for the settings to be on disk before the app quits. A save that failed, as on a full disk,
 * is said in words and tried again for as long as the user asks; Quit anyway leaves the last change
 * unsaved. `ask` answers with the index of the button chosen.
 */
export const saveBeforeQuit = async (
  settings: SettingsStore,
  ask: (prompt: { message: string; detail: string; buttons: ReadonlyArray<string> }) => Promise<number>,
) => {
  const copy = messages.settings;
  for (;;) {
    try {
      await settings.saved();
      return;
    } catch {
      const choice = await ask({
        message: copy.notSaved,
        detail: copy.notSavedDetail,
        buttons: [copy.tryAgain, copy.quit],
      });
      if (choice !== 0) return;
      // Saves every setting again.
      settings.update({});
    }
  }
};
