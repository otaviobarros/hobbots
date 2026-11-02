import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HubPort } from "@hobbots/domain";
import { Option, Schema } from "effect";

/**
 * Where the hub can be reached (ADR 021), kept in `network.json` in the Hobbots data folder: whether
 * remote access is on, and the port the user chose. The desktop app reads the port from the same
 * file before it starts or finds the hub. A setting never chosen is absent, so it keeps its default.
 */
export interface NetworkSettings {
  readonly remoteAccess?: boolean;
  readonly port?: number;
}

/** The port the hub listens on unless the user chose another. */
export const DEFAULT_PORT = 4317;

const settingsFile = (dataDir: string) => join(dataDir, "network.json");

const decodePort = Schema.decodeUnknownOption(HubPort);
const decodeRemoteAccess = Schema.decodeUnknownOption(Schema.Boolean);

/** The settings as stored. A missing or unreadable file, or a value out of range, reads as not chosen. */
export const readNetworkSettings = (dataDir: string): NetworkSettings => {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(settingsFile(dataDir), "utf8"));
  } catch {
    return {};
  }
  if (typeof value !== "object" || value === null) return {};
  const { remoteAccess, port } = value as Record<string, unknown>;
  return {
    ...Option.match(decodeRemoteAccess(remoteAccess), { onNone: () => ({}), onSome: (on) => ({ remoteAccess: on }) }),
    ...Option.match(decodePort(port), { onNone: () => ({}), onSome: (chosen) => ({ port: chosen }) }),
  };
};

/** Applies the change and returns the settings as stored. Written beside the file and renamed over it, so a crash never leaves half a file. */
export const writeNetworkSettings = (dataDir: string, change: NetworkSettings): NetworkSettings => {
  const next = { ...readNetworkSettings(dataDir), ...change };
  const file = settingsFile(dataDir);
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(`${file}.tmp`, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
  return next;
};

/**
 * The port the hub uses: `HOBBOTS_PORT` when it is set, as in development and tests, else the port
 * the user chose, else 4317.
 */
export const hubPort = (dataDir: string, env: Readonly<Record<string, string | undefined>>): number => {
  const fromEnv = Number(env.HOBBOTS_PORT);
  if (env.HOBBOTS_PORT !== undefined && Number.isInteger(fromEnv) && fromEnv > 0 && fromEnv <= 65535) return fromEnv;
  return readNetworkSettings(dataDir).port ?? DEFAULT_PORT;
};
