import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { processAlive } from "./hub-presence.ts";

/**
 * The lock every hub of this user takes while it moves sign-ins out of the keychain items every hub
 * shared before #1214, beside the user's own temporary files. Without it, two hubs starting together
 * could both copy the same sign-in, and a refresh by one would retire the other's token.
 *
 * The lock is a folder holding its owner's token: the owner's process ID and a random part. Every
 * step that takes, takes over or lets go of it is one `rename`, which the file system does whole:
 *
 * - A hub takes it by renaming a folder of its own, its token already inside, to the lock's name.
 *   That fails while the lock is there, since a folder is never renamed over one that holds a file.
 * - A hub takes over a lock whose owner's process is gone by renaming it to a tombstone named after
 *   that owner's token. Of two hubs that both saw the same dead owner, only the first rename works:
 *   once the tombstone is there, the second fails, whether the lock still has the dead owner or a
 *   new one by then. So no hub ever moves a live owner's lock aside.
 * - A hub lets go only of a lock that holds its own token.
 */
export const legacyKeychainLock = () => join(tmpdir(), `hobbots-${userInfo().uid}-legacy-keychain.lock`);

const OWNER = "owner";

/** A token for one hold of the lock: whose it is, and which time. */
export const lockToken = () => `${process.pid}-${randomUUID()}`;

const ownerOf = (lock: string) => {
  try {
    return readFileSync(join(lock, OWNER), "utf8").trim();
  } catch {
    return null;
  }
};

const pidOf = (token: string) => Number.parseInt(token.split("-")[0] ?? "", 10);

const code = (error: unknown) => (error as NodeJS.ErrnoException).code;

/** Whether `error` says the target of a folder's rename was already there. */
const taken = (error: unknown) => code(error) === "ENOTEMPTY" || code(error) === "EEXIST";

/**
 * Tries once to take the lock as `token`, taking over a lock whose owner's process is gone. Answers
 * whether this hub now holds it. Throws when the file system refuses for another reason.
 */
export const tryTakeLock = (lock: string, token: string): boolean => {
  const mine = `${lock}.${token}`;
  mkdirSync(mine, { recursive: true });
  writeFileSync(join(mine, OWNER), `${token}\n`, { mode: 0o600 });
  try {
    renameSync(mine, lock);
    return true;
  } catch (error) {
    if (!taken(error)) throw error;
  }
  rmSync(mine, { recursive: true, force: true });
  const owner = ownerOf(lock);
  // No owner: the lock was let go of in the meantime, so the next try may get it.
  if (owner === null || processAlive(pidOf(owner))) return false;
  try {
    renameSync(lock, `${lock}.dead-${owner}`);
  } catch (error) {
    // Another hub took it over first, or it was let go of.
    if (!taken(error) && code(error) !== "ENOENT") throw error;
    return false;
  }
  // The tombstone stays: while it is there, a hub that saw the same dead owner cannot move the next
  // owner's lock aside. It is left only by a hub that stopped while it held the lock.
  return tryTakeLock(lock, token);
};

/** Lets go of the lock, only while it is still held as `token`. */
export const releaseLock = (lock: string, token: string) => {
  if (ownerOf(lock) !== token) return;
  const done = `${lock}.done-${token}`;
  renameSync(lock, done);
  rmSync(done, { recursive: true, force: true });
};
