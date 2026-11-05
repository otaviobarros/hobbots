import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Redacted } from "effect";

/**
 * The hub's three credentials for its memory engine (ADR 028): the root bearer, for setup and your
 * own edits, the trusted-proxy bearer, for everything a hob does, and the model bearer, which the
 * engine presents to the hub's memory model endpoint. They never leave the hub: the engine gets them
 * only in its environment, and no sandbox, config file or backup holds them.
 */
export interface MemoryKeys {
  readonly root: Redacted.Redacted<string>;
  readonly proxy: Redacted.Redacted<string>;
  readonly model: Redacted.Redacted<string>;
}

/** Where the keys live: in the hub's data folder, outside the engine's own, so its backup never holds them. */
export const memoryKeysFile = (dataDir: string) => join(dataDir, "memory-keys");

const KEY = /^[0-9a-f]{64}$/;
const OWNER_ONLY = 0o600;

const newKey = () => randomBytes(32).toString("hex");

interface SavedKeys {
  readonly root: string;
  readonly proxy: string;
  readonly model: string;
}

/**
 * The keys in the file, or undefined when it holds anything but distinct keys. A file from before
 * the model bearer keeps its two keys and gains a new model key.
 */
const read = (file: string): { readonly keys: SavedKeys; readonly complete: boolean } | undefined => {
  try {
    const saved: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (typeof saved !== "object" || saved === null) return undefined;
    const { root, proxy, model } = saved as Record<string, unknown>;
    if (typeof root !== "string" || typeof proxy !== "string") return undefined;
    const complete = typeof model === "string";
    const keys = { root, proxy, model: complete ? model : newKey() };
    if (![keys.root, keys.proxy, keys.model].every((key) => KEY.test(key))) return undefined;
    if (new Set([keys.root, keys.proxy, keys.model]).size !== 3) return undefined;
    return { keys, complete };
  } catch {
    return undefined;
  }
};

/** Writes the keys over any there, owner-only, in one rename, and answers them. */
const writeKeys = (file: string, keys: SavedKeys = { root: newKey(), proxy: newKey(), model: newKey() }) => {
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
  writeKeys(memoryKeysFile(dataDir));
};

/**
 * The hub's memory keys, made the first time and kept owner-only. A file that cannot be read, or
 * holds anything but distinct keys, is replaced with new ones: the engine reads its keys only from
 * its environment, so new keys work at its next start and old ones stop working.
 */
export const loadOrCreateMemoryKeys = (dataDir: string): MemoryKeys => {
  const file = memoryKeysFile(dataDir);
  const saved = existsSync(file) ? read(file) : undefined;
  const keys = saved === undefined ? writeKeys(file) : saved.complete ? saved.keys : writeKeys(file, saved.keys);
  // A copy restored or moved by hand can arrive readable by others.
  if ((statSync(file).mode & 0o777) !== OWNER_ONLY) chmodSync(file, OWNER_ONLY);
  return { root: Redacted.make(keys.root), proxy: Redacted.make(keys.proxy), model: Redacted.make(keys.model) };
};
