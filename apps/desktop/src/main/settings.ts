import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

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
}

export interface SettingsStore {
  readonly read: () => DesktopSettings;
  /** Merges `patch` into the file; a key set to undefined is removed. */
  readonly update: (patch: DesktopSettings) => DesktopSettings;
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
  };
};

/** A small JSON file in the app's data folder. A missing or unreadable file reads as no choices made. */
export const fileSettingsStore = (file: string): SettingsStore => {
  const read = () => {
    try {
      return parse(readFileSync(file, "utf8"));
    } catch {
      return {};
    }
  };
  return {
    read,
    update: (patch) => {
      const next = { ...read(), ...patch };
      mkdirSync(dirname(file), { recursive: true });
      // Written beside the file and renamed over it, so a crash never leaves half a file.
      writeFileSync(`${file}.tmp`, `${JSON.stringify(next, null, 2)}\n`);
      renameSync(`${file}.tmp`, file);
      return next;
    },
  };
};
