import type { Dirent } from "node:fs";
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
 * with its case swapped. Nothing here follows a symlink, and a swapped name the folder lists as an
 * entry of its own is a different file, so a sibling `PROJECT -> project` link on a case-sensitive
 * volume cannot pass for case folding. Cached per device.
 */
const probeCaseSensitivity = async (dir: string, cache: Map<number, boolean>): Promise<boolean> => {
  const device = (await fs.lstat(dir)).dev;
  const cached = cache.get(device);
  if (cached !== undefined) return cached;
  let result = platformDefault();
  let current = dir;
  while (path.dirname(current) !== current) {
    const own = await fs.lstat(current);
    // Above a mount point the answer would be the parent volume's.
    if (own.dev !== device) break;
    const name = path.basename(current);
    const swapped = swapCase(name);
    if (swapped !== name) {
      const parent = path.dirname(current);
      if ((await fs.readdir(parent)).includes(swapped)) {
        result = true;
      } else {
        try {
          const other = await fs.lstat(path.join(parent, swapped));
          result = !(other.dev === own.dev && other.ino === own.ino);
        } catch (error) {
          if (!isMissing(error)) throw error;
          result = true;
        }
      }
      break;
    }
    current = path.dirname(current);
  }
  cache.set(device, result);
  return result;
};

/** The most entries searched below a directory for Git repositories before giving up closed. */
export const MAX_SEARCHED_ENTRIES = 50_000;

/** The Git resources inside a repository folder that hobs can only read (ADR 014). */
const GIT_PROTECTED = [path.join(".git", "hooks"), path.join(".git", "config")];

export class PathResolver extends Context.Service<
  PathResolver,
  {
    /** Canonicalizes `input`, resolving a relative path against `base`. */
    readonly canonicalize: (input: string, base: string) => Effect.Effect<CanonicalPath, PathResolutionError>;
    /**
     * The canonical Git hooks folders and config files a change to `target` could touch: those of
     * every folder above it, wherever their links point, and, when it is a directory, those of every
     * repository at or below it. A directory too large to search returns the target
     * itself, so it is treated as protected.
     */
    readonly protectedGitPaths: (target: CanonicalPath) => Effect.Effect<ReadonlyArray<string>, PathResolutionError>;
    /**
     * The canonical Git hooks folders and config files of every repository at, above or below the
     * given folders, wherever their links point, so a hooks folder linked into another folder is
     * protected when reached directly. A folder too large to search returns the folder itself.
     */
    readonly protectedGitPathsIn: (
      folders: ReadonlyArray<CanonicalPath>,
    ) => Effect.Effect<ReadonlyArray<string>, PathResolutionError>;
  }
>()("@hobbots/permissions/PathResolver") {
  /** Resolves against the hub's own file system. */
  static readonly node = Layer.sync(PathResolver, () => {
    const cache = new Map<number, boolean>();
    const canonical = async (input: string): Promise<string> => resolvePath(input, { count: 0 });
    const exists = (p: string) =>
      fs.lstat(p).then(
        () => true,
        (error) => {
          if (isMissing(error)) return false;
          throw error;
        },
      );
    const repositoryResources = (repository: string): Promise<ReadonlyArray<string>> =>
      Promise.all(GIT_PROTECTED.map((r) => canonical(path.join(repository, r))));
    const resourcesOf = async (repository: string): Promise<ReadonlyArray<string>> =>
      (await exists(path.join(repository, ".git")))
        ? repositoryResources(repository)
        : // Not a repository yet: creating these would make one, so their plain spelling stays protected.
          GIT_PROTECTED.map((r) => path.join(repository, r));
    const ancestorsOf = (p: string): Array<string> => {
      const found: Array<string> = [];
      for (let dir = p; path.dirname(dir) !== dir; ) {
        dir = path.dirname(dir);
        found.push(dir);
      }
      return found;
    };
    /** Repositories below `dir`, without following links; null when there are too many entries. */
    const repositoriesBelow = async (dir: string, caseSensitive: boolean): Promise<Array<string> | null> => {
      const found: Array<string> = [];
      const pending = [dir];
      let searched = 0;
      for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
        let entries: Array<Dirent>;
        try {
          entries = await fs.readdir(current, { withFileTypes: true });
        } catch (error) {
          if (isMissing(error)) continue;
          throw error;
        }
        searched += entries.length;
        if (searched > MAX_SEARCHED_ENTRIES) return null;
        for (const entry of entries) {
          if (comparable(entry.name, caseSensitive) === ".git") found.push(current);
          else if (entry.isDirectory()) pending.push(path.join(current, entry.name));
        }
      }
      return found;
    };
    return {
      canonicalize: (input, base) =>
        Effect.tryPromise({
          try: async () => {
            const resolved = await canonical(absolute(absolute(process.cwd(), base), input));
            const caseSensitive = await probeCaseSensitivity(await nearestExisting(resolved), cache);
            return { path: resolved, caseSensitive };
          },
          catch: (error) => new PathResolutionError({ path: input, message: String(error) }),
        }),
      protectedGitPaths: (target) =>
        Effect.tryPromise({
          try: async () => {
            const repositories = ancestorsOf(target.path);
            const stats = await fs.lstat(target.path).catch(() => null);
            if (stats?.isDirectory()) {
              const below = await repositoriesBelow(target.path, target.caseSensitive);
              if (below === null) return [target.path];
              // Only actual repositories: removing a folder cannot touch a `.git` it does not hold.
              repositories.push(...below);
            }
            return (await Promise.all(repositories.map(resourcesOf))).flat();
          },
          catch: (error) => new PathResolutionError({ path: target.path, message: String(error) }),
        }),
      protectedGitPathsIn: (folders) =>
        Effect.tryPromise({
          try: async () => {
            const repositories = new Set<string>();
            const tooLarge: Array<string> = [];
            for (const folder of folders) {
              const below = await repositoriesBelow(folder.path, folder.caseSensitive);
              if (below === null) tooLarge.push(folder.path);
              for (const repository of [...ancestorsOf(folder.path), ...(below ?? [])]) {
                if (await exists(path.join(repository, ".git"))) repositories.add(repository);
              }
            }
            const resources = await Promise.all([...repositories].map(repositoryResources));
            return [...tooLarge, ...resources.flat()];
          },
          catch: (error) =>
            new PathResolutionError({ path: folders.map((f) => f.path).join(", "), message: String(error) }),
        }),
    };
  });
}
