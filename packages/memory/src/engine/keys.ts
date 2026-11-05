import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Redacted } from "effect";

/**
 * The hub's two credentials for its memory engine (ADR 028): the root bearer, for setup and your
 * own edits, and the trusted-proxy bearer, for everything a hob does. They never leave the hub:
 * the engine gets them only in its environment, and no sandbox, config file or backup holds them.
 */
export interface MemoryKeys {
  readonly root: Redacted.Redacted<string>;
  readonly proxy: Redacted.Redacted<string>;
}

/** Where the keys live: in the hub's data folder, outside the engine's own, so its backup never holds them. */
export const memoryKeysFile = (dataDir: string) => join(dataDir, "memory-keys");

const KEY = /^[0-9a-f]{64}$/;
const OWNER_ONLY = 0o600;

const newKey = () => randomBytes(32).toString("hex");

const read = (file: string): { readonly root: string; readonly proxy: string } | undefined => {
  try {
    const saved: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (typeof saved !== "object" || saved === null) return undefined;
    const { root, proxy } = saved as Record<string, unknown>;
    if (typeof root !== "string" || typeof proxy !== "string") return undefined;
    if (!KEY.test(root) || !KEY.test(proxy) || root === proxy) return undefined;
    return { root, proxy };
  } catch {
    return undefined;
  }
};

/** Writes two new keys over any there, owner-only, in one rename, and answers them. */
const writeNewKeys = (file: string) => {
  const keys = { root: newKey(), proxy: newKey() };
  const draft = `${file}.${process.pid}.tmp`;
  writeFileSync(draft, `${JSON.stringify({ version: 1, ...keys })}\n`, { mode: OWNER_ONLY });
  renameSync(draft, file);
  return keys;
};

/**
 * Gives the hub new memory keys, as a restore does (ADR 028): the engine reads its keys only from
 * its environment, so at its next start the new keys work and the old ones no longer do.
 */
export const replaceMemoryKeys = (dataDir: string): void => {
  writeNewKeys(memoryKeysFile(dataDir));
};

/**
 * The hub's memory keys, made the first time and kept owner-only. A file that cannot be read, or
 * holds anything but two distinct keys, is replaced with new ones: the engine reads its keys only
 * from its environment, so new keys work at its next start and old ones stop working.
 */
export const loadOrCreateMemoryKeys = (dataDir: string): MemoryKeys => {
  const file = memoryKeysFile(dataDir);
  let keys = existsSync(file) ? read(file) : undefined;
  if (keys === undefined) keys = writeNewKeys(file);
  // A copy restored or moved by hand can arrive readable by others.
  if ((statSync(file).mode & 0o777) !== OWNER_ONLY) chmodSync(file, OWNER_ONLY);
  return { root: Redacted.make(keys.root), proxy: Redacted.make(keys.proxy) };
};
