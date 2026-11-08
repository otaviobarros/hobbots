import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";

/**
 * Apple's developer tool shims in /usr/bin (`git`, `python3`, `make` and the rest) look up the tool
 * they stand for through xcrun, which keeps its answers in `xcrun_db` in the user's own temporary
 * folder (`getconf DARWIN_USER_TEMP_DIR`), whatever `TMPDIR` says. The sandbox closes that folder
 * (#578), so each call inside it missed the cache, tried to write a new one and printed
 * "couldn't create cache file … (errno=Operation not permitted)" twice (#1219).
 *
 * The cache opens for reading only. A hob that could write it could point the user's own `git` or
 * `python3`, run later outside the sandbox, at a program in its folders, so it stays closed for
 * writing; and `xcrun_nocache` still writes it.
 */
export const XCRUN_CACHE = "xcrun_db";

/** The user's own temporary folder on macOS, or undefined when `getconf` cannot say. */
const userTempFolder = (): string | undefined => {
  try {
    const folder = execFileSync("/usr/bin/getconf", ["DARWIN_USER_TEMP_DIR"], { encoding: "utf8", timeout: 5_000 });
    return folder.trim() || undefined;
  } catch {
    return undefined;
  }
};

const realOrSelf = (path: string) => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

/**
 * The xcrun cache a turn's processes may read, as written and at its real location (`/var` is
 * `/private/var` on macOS), or none off macOS.
 */
export const xcrunCacheFiles = (
  isMac: boolean = platform() === "darwin",
  tempFolder: () => string | undefined = userTempFolder,
): ReadonlyArray<string> => {
  const folder = isMac ? tempFolder() : undefined;
  if (folder === undefined) return [];
  const cache = join(folder, XCRUN_CACHE);
  return [...new Set([cache, join(realOrSelf(folder), XCRUN_CACHE)])];
};
