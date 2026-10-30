import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Context, Effect, Layer, Schema } from "effect";

/**
 * Canonical paths (ADR 014): absolute, with `.` and `..` and every symlink resolved, a path that
 * does not exist yet resolved through its nearest existing parent, compared with the case
 * sensitivity of the volume it lives on. Resolution touches the disk; comparison is pure.
 */
export interface CanonicalPath {
  readonly path: string;
  /** Whether the volume holding the path tells `Code` and `code` apart. */
  readonly caseSensitive: boolean;
}

export class PathResolutionError extends Schema.TaggedError<PathResolutionError>()("PathResolutionError", {
  path: Schema.String,
  message: Schema.String,
}) {}

/** Matches Linux's limit on symlinks followed while resolving one path. */
const MAX_SYMLINKS = 40;

const comparable = (p: string, caseSensitive: boolean): string =>
  caseSensitive ? p : p.normalize("NFC").toLowerCase();

/** Whether `target` is `folder` or inside it, by canonical form and the target's volume. */
export const isInside = (target: CanonicalPath, folder: string): boolean => {
  const t = comparable(target.path, target.caseSensitive);
  const f = comparable(folder, target.caseSensitive);
  if (t === f) return true;
  return t.startsWith(f.endsWith(path.sep) ? f : f + path.sep);
};

/** The segments of `target` below `folder`, or null when it is not inside it. */
export const segmentsBelow = (target: CanonicalPath, folder: string): ReadonlyArray<string> | null => {
  if (!isInside(target, folder)) return null;
  const rest = target.path.slice(folder.length);
  return rest.split(path.sep).filter((segment) => segment.length > 0);
};

/**
 * Joins without normalizing: `path.resolve` would fold `link/..` away before the link is followed,
 * which is exactly the escape this module exists to catch.
 */
const absolute = (base: string, input: string): string =>
  path.isAbsolute(input) ? input : `${base}${path.sep}${input}`;

const isMissing = (error: unknown): boolean => {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
};

/**
 * Resolves `input` component by component, the way the kernel does when a tool opens it, so a
 * `..` after a symlink climbs from the link's target and not from the link's own folder. A
 * dangling symlink resolves to its target, since writing through it creates the target.
 */
const resolvePath = async (input: string, followed: { count: number }): Promise<string> => {
  const parsed = path.parse(input);
  const pending = input.slice(parsed.root.length).split(path.sep);
  let resolved = parsed.root;
  let missing = false;
  for (const component of pending) {
    if (component === "" || component === ".") continue;
    if (component === "..") {
      resolved = path.dirname(resolved);
      // Climbing out of a missing folder can land on one that exists, with links below it.
      missing = false;
      continue;
    }
    const candidate = path.join(resolved, component);
    if (missing) {
      resolved = candidate;
      continue;
    }
    let stats: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      stats = await fs.lstat(candidate);
    } catch (error) {
      if (!isMissing(error)) throw error;
      missing = true;
      resolved = candidate;
      continue;
    }
    if (!stats.isSymbolicLink()) {
      resolved = candidate;
      continue;
    }
    followed.count += 1;
    if (followed.count > MAX_SYMLINKS) throw new Error("Too many symbolic links");
    const link = await fs.readlink(candidate);
    resolved = await resolvePath(absolute(resolved, link), followed);
    // The target may itself be missing; later components then cannot exist either, unless a
    // `..` climbs back, which the next lstat finds out.
    missing = false;
  }
  return resolved;
};

const nearestExisting = async (p: string): Promise<string> => {
  let current = p;
  for (;;) {
    try {
      await fs.stat(current);
      return current;
    } catch (error) {
      if (!isMissing(error)) throw error;
      const parent = path.dirname(current);
      if (parent === current) return current;
      current = parent;
    }
  }
};

const swapCase = (name: string): string =>
  [...name].map((c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase())).join("");

const platformDefault = (): boolean => process.platform !== "darwin" && process.platform !== "win32";

/**
 * Whether the volume holding the existing path `dir` is case-sensitive: look up an ancestor's name
 * with its case swapped and see whether it is the same file. Cached per device.
 */
const probeCaseSensitivity = async (dir: string, cache: Map<number, boolean>): Promise<boolean> => {
  const stats = await fs.stat(dir);
  const cached = cache.get(stats.dev);
  if (cached !== undefined) return cached;
  let result = platformDefault();
  let current = dir;
  while (path.dirname(current) !== current) {
    const name = path.basename(current);
    const swapped = swapCase(name);
    if (swapped !== name) {
      const own = await fs.stat(current);
      try {
        const other = await fs.stat(path.join(path.dirname(current), swapped));
        result = !(other.dev === own.dev && other.ino === own.ino);
      } catch (error) {
        if (!isMissing(error)) throw error;
        result = true;
      }
      break;
    }
    current = path.dirname(current);
  }
  cache.set(stats.dev, result);
  return result;
};

export class PathResolver extends Context.Service<
  PathResolver,
  {
    /** Canonicalizes `input`, resolving a relative path against `base`. */
    readonly canonicalize: (input: string, base: string) => Effect.Effect<CanonicalPath, PathResolutionError>;
  }
>()("@hobbots/permissions/PathResolver") {
  /** Resolves against the hub's own file system. */
  static readonly node = Layer.sync(PathResolver, () => {
    const cache = new Map<number, boolean>();
    return {
      canonicalize: (input, base) =>
        Effect.tryPromise({
          try: async () => {
            const resolved = await resolvePath(absolute(absolute(process.cwd(), base), input), { count: 0 });
            const caseSensitive = await probeCaseSensitivity(await nearestExisting(resolved), cache);
            return { path: resolved, caseSensitive };
          },
          catch: (error) => new PathResolutionError({ path: input, message: String(error) }),
        }),
    };
  });
}
