import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Choices that belong to this Mac rather than to the hub, such as whether Hobbots opens at login
 * or keeps running in the menu bar.
 * A setting that was never chosen is absent, so each one keeps its own default.
 */
export interface DesktopSettings {
  readonly openAtLogin?: boolean;
  /** Closing the last window keeps the app, the server and running work alive (ADR 012). */
  readonly keepRunningInMenuBar?: boolean;
}

export interface SettingsStore {
  readonly read: () => DesktopSettings;
  readonly update: (patch: DesktopSettings) => DesktopSettings;
}

const parse = (raw: string): DesktopSettings => {
  const value: unknown = JSON.parse(raw);
  if (typeof value !== "object" || value === null) return {};
  const { openAtLogin, keepRunningInMenuBar } = value as Record<string, unknown>;
  return {
    ...(typeof openAtLogin === "boolean" ? { openAtLogin } : {}),
    ...(typeof keepRunningInMenuBar === "boolean" ? { keepRunningInMenuBar } : {}),
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
