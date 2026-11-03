import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

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
}

export interface SettingsStore {
  readonly read: () => DesktopSettings;
  readonly update: (patch: DesktopSettings) => DesktopSettings;
}

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
  return Object.fromEntries(
    BOOLEAN_KEYS.flatMap((key) => (typeof record[key] === "boolean" ? [[key, record[key]]] : [])),
  );
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
