import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { SkillFiles } from "@hobbots/agents";
import { type SkillRevisionHash, SkillSourceUnreadable } from "@hobbots/domain";
import { Context, Effect, Layer } from "effect";
import type { SkillContent } from "./hash.ts";

/**
 * The files of every revision, in `<data folder>/skills/objects/<hash>/` (ADR 029, Storage and
 * revisions): written once, read-only, and never changed. A revision is written into a folder of its
 * own and moved into place whole, so a hub that stops halfway leaves no half-written revision. Its files
 * are read-only and its folders stay writable to their owner, so the data folder can still be removed
 * with a plain `rm -rf`; no turn writes here, since the store is outside every folder a hob may write.
 */
export interface SkillObjectsShape {
  /** Writes a revision's files, unless its folder is there already; answers the folder. */
  readonly put: (hash: SkillRevisionHash, contents: ReadonlyArray<SkillContent>) => Effect.Effect<string>;
  readonly folder: (hash: SkillRevisionHash) => Effect.Effect<string | null>;
  /** The folder every revision's folder is in, which backups take as a whole. */
  readonly root: string;
  /**
   * Writes a draft's files for a chat that tries it (ADR 029, Try in a chat), in a folder of their own
   * beside the revisions', so a draft is never a revision and no backup takes it; answers the folder.
   */
  readonly putDraft: (hash: SkillRevisionHash, contents: ReadonlyArray<SkillContent>) => Effect.Effect<string>;
  readonly draft: (hash: SkillRevisionHash) => Effect.Effect<string | null>;
}

export class SkillObjects extends Context.Service<SkillObjects, SkillObjectsShape>()("@hobbots/skills/SkillObjects") {}

const exists = (path: string) =>
  lstat(path).then(
    () => true,
    () => false,
  );

/** A revision's folders: writable to their owner only, so they can be removed (#1196). */
const FOLDER_MODE = 0o755;

/** Sets every folder under `folder` to `FOLDER_MODE`, its files untouched. */
const openFolders = async (folder: string): Promise<void> => {
  await chmod(folder, FOLDER_MODE);
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    if (entry.isDirectory()) await openFolders(join(folder, entry.name));
  }
};

/**
 * Opens the folders of revisions an earlier hub sealed read-only, whose files stay read-only, so a
 * data folder written before #1196 can be removed too. A folder already open is left as it is.
 */
const openSealedRevisions = async (root: string): Promise<void> => {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(root, entry.name);
    if (((await lstat(path)).mode & 0o200) === 0) await openFolders(path);
  }
};

const write = async (objects: string, hash: string, contents: ReadonlyArray<SkillContent>): Promise<string> => {
  const target = join(objects, hash);
  if (await exists(target)) return target;
  const staging = join(objects, `.staging-${randomUUID()}`);
  try {
    for (const file of contents) {
      const path = join(staging, ...file.path.split("/"));
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, file.bytes, { mode: file.mode === "executable" ? 0o555 : 0o444, flag: "wx" });
    }
    await mkdir(staging, { recursive: true });
    await openFolders(staging);
    await rename(staging, target).catch(async (error: NodeJS.ErrnoException) => {
      // Another import of the same content won the race; its folder holds the same files.
      if (!(await exists(target))) throw error;
    });
    return target;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
};

/** The object store under `skills` in `dataFolder`, with `SkillFiles` for the hub to read it. */
export const SkillObjectsLive = (dataFolder: string) => {
  const root = join(dataFolder, "skills", "objects");
  const drafts = join(dataFolder, "skills", "drafts");
  const objects = Layer.effect(
    SkillObjects,
    Effect.gen(function* () {
      yield* Effect.promise(() => mkdir(root, { recursive: true, mode: 0o700 }));
      yield* Effect.promise(() => mkdir(drafts, { recursive: true, mode: 0o700 }));
      yield* Effect.promise(() => openSealedRevisions(root));
      const inside = (base: string) => (hash: SkillRevisionHash) =>
        Effect.promise(async () => ((await exists(join(base, hash))) ? join(base, hash) : null));
      return SkillObjects.of({
        root,
        folder: inside(root),
        put: (hash, contents) => Effect.promise(() => write(root, hash, contents)),
        putDraft: (hash, contents) => Effect.promise(() => write(drafts, hash, contents)),
        draft: inside(drafts),
      });
    }),
  );
  const files = Layer.effect(
    SkillFiles,
    Effect.gen(function* () {
      const store = yield* SkillObjects;
      return SkillFiles.of({
        folder: store.folder,
        draft: store.draft,
        read: (hash, path) =>
          Effect.gen(function* () {
            const folder = yield* store.folder(hash);
            const target = folder === null ? null : resolve(folder, path);
            // Only a file inside the revision's own folder.
            if (folder === null || target === null || !target.startsWith(`${folder}${sep}`)) {
              return yield* new SkillSourceUnreadable({ message: `The hub has no ${path} for revision ${hash}.` });
            }
            return yield* Effect.tryPromise({
              try: () => readFile(target),
              catch: () => new SkillSourceUnreadable({ message: `${path} of revision ${hash} could not be read.` }),
            });
          }),
      });
    }),
  );
  return Layer.provideMerge(files, objects);
};
