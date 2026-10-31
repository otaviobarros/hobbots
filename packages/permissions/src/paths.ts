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

/**
 * The most entries searched below a folder for Git repositories before giving up closed. A large
 * checkout with its dependencies installed holds a few hundred thousand.
 */
export const MAX_SEARCHED_ENTRIES = 1_000_000;

/** The Git resources inside a repository folder that hobs can only read (ADR 014). */
const GIT_PROTECTED = [path.join(".git", "hooks"), path.join(".git", "config")];

/** The Git resources found across the hob's folders. */
export interface ScopeGitResources {
  /** Canonical hooks folders, hook files they link to, and config files. */
  readonly paths: ReadonlyArray<string>;
  /** Folders too large to search, where an unseen repository could link its hooks. */
  readonly unsearched: ReadonlyArray<string>;
}

/** Coarser than any timestamp precision the hub's file systems have (FAT keeps two seconds). */
const RACY_MS = 2_000;

interface IndexedDir {
  readonly mtimeMs: number;
  /** Change time, which also moves when the modification time is set back, and cannot be set itself. */
  readonly ctimeMs: number;
  readonly dev: number;
  /** When it was listed: a change within the file system's timestamp precision of that may not show. */
  readonly listedAt: number;
  readonly ino: number;
  readonly entries: number;
  readonly repository: boolean;
  readonly children: ReadonlyArray<string>;
}

/**
 * Every directory below a folder, without following links or entering `.git`, and which of them
 * are repositories. Kept between decisions and brought up to date by re-listing only directories
 * whose modification time changed, since adding, removing or renaming an entry (a new `.git`, a
 * moved repository) changes its parent's.
 */
interface FolderIndex {
  readonly dirs: Map<string, IndexedDir>;
  entries: number;
}

export interface PathResolverOptions {
  readonly maxSearchedEntries: number;
  /** The wall clock, in milliseconds; tests move it to tell a racy listing from a stale one. */
  readonly now?: () => number;
  /** Runs before each directory is listed for the index; tests use it to make refreshes overlap. */
  readonly beforeList?: (dir: string) => Promise<void>;
}

export class PathResolver extends Context.Service<
  PathResolver,
  {
    /** Canonicalizes `input`, resolving a relative path against `base`. */
    readonly canonicalize: (input: string, base: string) => Effect.Effect<CanonicalPath, PathResolutionError>;
    /**
     * The canonical Git resources a change to `target` could touch: those of every folder above it,
     * wherever their links point, and, when it is a directory, those of every repository at or below
     * it. A directory too large to search returns the target itself, so it is treated as protected.
     */
    readonly protectedGitPaths: (target: CanonicalPath) => Effect.Effect<ReadonlyArray<string>, PathResolutionError>;
    /**
     * The canonical Git resources of every repository at, above or below the given folders,
     * wherever their links point, so a hooks folder linked into another folder is protected when
     * reached directly, including repositories nested in another's working tree. A folder with
     * more entries than the limit is reported unsearched.
     */
    readonly protectedGitPathsIn: (
      folders: ReadonlyArray<CanonicalPath>,
    ) => Effect.Effect<ScopeGitResources, PathResolutionError>;
  }
>()("@hobbots/permissions/PathResolver") {
  /** Resolves against the hub's own file system. */
  static readonly make = (options: PathResolverOptions) =>
    Layer.sync(PathResolver, () => {
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
      const isRepository = (dir: string) => exists(path.join(dir, ".git"));
      /** The hooks folder and config, and the files the hooks folder's entries link to. */
      const repositoryResources = async (repository: string): Promise<ReadonlyArray<string>> => {
        const [hooks, config] = await Promise.all(GIT_PROTECTED.map((r) => canonical(path.join(repository, r))));
        const entries = await fs.readdir(hooks as string, { withFileTypes: true }).catch((error) => {
          if (isMissing(error)) return [];
          throw error;
        });
        const linked = await Promise.all(
          entries.filter((e) => e.isSymbolicLink()).map((e) => canonical(path.join(hooks as string, e.name))),
        );
        return [hooks as string, config as string, ...linked];
      };
      const resourcesOf = async (repository: string): Promise<ReadonlyArray<string>> =>
        (await isRepository(repository))
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
      /**
       * Repositories at or below `dir`, without following links or entering a repository's working
       * tree; null when the search passes the entry limit.
       */
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
          if (entries.some((e) => comparable(e.name, caseSensitive) === ".git")) {
            found.push(current);
            continue;
          }
          searched += entries.length;
          if (searched > options.maxSearchedEntries) return null;
          for (const entry of entries) if (entry.isDirectory()) pending.push(path.join(current, entry.name));
        }
        return found;
      };
      const indexes = new Map<string, FolderIndex>();
      const now = options.now ?? Date.now;
      /** The refresh running for each indexed folder: one at a time, since each builds on the last. */
      const refreshing = new Map<string, Promise<unknown>>();
      const listDir = async (dir: string, caseSensitive: boolean) => {
        await options.beforeList?.(dir);
        const stats = await fs.lstat(dir);
        // A directory replaced by a link is gone from the index; `readdir` would follow the link.
        if (!stats.isDirectory()) return null;
        const entries = await fs.readdir(dir, { withFileTypes: true });
        const repository = entries.some((e) => comparable(e.name, caseSensitive) === ".git");
        const children = entries
          .filter((e) => e.isDirectory() && comparable(e.name, caseSensitive) !== ".git")
          .map((e) => path.join(dir, e.name));
        return {
          mtimeMs: stats.mtimeMs,
          ctimeMs: stats.ctimeMs,
          dev: stats.dev,
          listedAt: now(),
          ino: stats.ino,
          entries: entries.length,
          repository,
          children,
        };
      };
      const forget = (index: FolderIndex, dir: string) => {
        const known = index.dirs.get(dir);
        if (known === undefined) return;
        index.dirs.delete(dir);
        index.entries -= known.entries;
        for (const child of known.children) forget(index, child);
      };
      /** Lists `dirs` and every new directory below them; false once past the entry limit. */
      const visit = async (index: FolderIndex, dirs: Array<string>, caseSensitive: boolean): Promise<boolean> => {
        for (let dir = dirs.pop(); dir !== undefined; dir = dirs.pop()) {
          let listed: IndexedDir | null;
          try {
            listed = await listDir(dir, caseSensitive);
          } catch (error) {
            if (!isMissing(error)) throw error;
            listed = null;
          }
          if (listed === null) {
            forget(index, dir);
            continue;
          }
          const known = index.dirs.get(dir);
          index.entries += listed.entries - (known?.entries ?? 0);
          if (index.entries > options.maxSearchedEntries) return false;
          index.dirs.set(dir, listed);
          const kept = new Set(listed.children);
          for (const child of known?.children ?? []) if (!kept.has(child)) forget(index, child);
          for (const child of listed.children) if (!index.dirs.has(child)) dirs.push(child);
        }
        return true;
      };
      /** The repositories at or below `folder`, or null when it holds more entries than the limit. */
      const repositoriesIn = (folder: CanonicalPath): Promise<ReadonlyArray<string> | null> => {
        const key = `${folder.caseSensitive}:${folder.path}`;
        // A refresh publishes directories before their descendants, so an overlapping one would
        // take a half-listed subtree as complete. Each waits for the one before it.
        const run = (refreshing.get(key) ?? Promise.resolve())
          .catch(() => undefined)
          .then(() => refresh(key, folder))
          .catch((error) => {
            // A refresh that failed partway leaves a partial index; the next one starts afresh.
            indexes.delete(key);
            throw error;
          });
        refreshing.set(key, run);
        return run.finally(() => {
          if (refreshing.get(key) === run) refreshing.delete(key);
        });
      };
      const refresh = async (key: string, folder: CanonicalPath): Promise<ReadonlyArray<string> | null> => {
        let index = indexes.get(key);
        let changed: Array<string>;
        if (index === undefined) {
          index = { dirs: new Map(), entries: 0 };
          changed = [folder.path];
        } else {
          const known = [...index.dirs];
          const current = await Promise.all(known.map(([dir]) => fs.lstat(dir).catch(() => null)));
          changed = known.flatMap(([dir, entry], i) => {
            const stats = current[i];
            const unchanged =
              stats?.isDirectory() &&
              stats.mtimeMs === entry.mtimeMs &&
              stats.ctimeMs === entry.ctimeMs &&
              stats.ino === entry.ino &&
              stats.dev === entry.dev &&
              // Like Git's racy index entries, a listing too close to the last change is redone.
              entry.listedAt - Math.max(entry.mtimeMs, entry.ctimeMs) > RACY_MS;
            return unchanged ? [] : [dir];
          });
          // A replaced directory is listed afresh, along with whatever is new below it.
          for (const dir of changed) {
            const entry = index.dirs.get(dir);
            if (entry !== undefined) index.dirs.set(dir, { ...entry, mtimeMs: Number.NaN });
          }
        }
        if (!(await visit(index, changed, folder.caseSensitive))) {
          indexes.delete(key);
          return null;
        }
        indexes.set(key, index);
        return [...index.dirs].flatMap(([dir, entry]) => (entry.repository ? [dir] : []));
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
              const unsearched: Array<string> = [];
              for (const folder of folders) {
                const above: Array<string> = [];
                for (const dir of ancestorsOf(folder.path)) if (await isRepository(dir)) above.push(dir);
                const below = await repositoriesIn(folder);
                if (below === null) unsearched.push(folder.path);
                for (const repository of [...above, ...(below ?? [])]) repositories.add(repository);
              }
              const resources = await Promise.all([...repositories].map(repositoryResources));
              return { paths: resources.flat(), unsearched };
            },
            catch: (error) =>
              new PathResolutionError({ path: folders.map((f) => f.path).join(", "), message: String(error) }),
          }),
      };
    });

  static readonly node = PathResolver.make({ maxSearchedEntries: MAX_SEARCHED_ENTRIES });
}
