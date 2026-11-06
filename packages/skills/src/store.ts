import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { SkillFiles } from "@hobbots/agents";
import type { SkillRevisionHash } from "@hobbots/domain";
import { Context, Effect, Layer } from "effect";
import type { SkillContent } from "./hash.ts";

/**
 * The files of every revision, in `<data folder>/skills/objects/<hash>/` (ADR 029, Storage and
 * revisions): written once, read-only, and never changed. A revision is written into a folder of its
 * own and moved into place whole, so a hub that stops halfway leaves no half-written revision.
 */
export interface SkillObjectsShape {
  /** Writes a revision's files, unless its folder is there already; answers the folder. */
  readonly put: (hash: SkillRevisionHash, contents: ReadonlyArray<SkillContent>) => Effect.Effect<string>;
  readonly folder: (hash: SkillRevisionHash) => Effect.Effect<string | null>;
  /** The folder every revision's folder is in, which backups take as a whole. */
  readonly root: string;
}

export class SkillObjects extends Context.Service<SkillObjects, SkillObjectsShape>()("@hobbots/skills/SkillObjects") {}

const exists = (path: string) =>
  lstat(path).then(
    () => true,
    () => false,
  );

/** Makes every folder and file under `folder` read-only, folders last. */
const seal = async (folder: string): Promise<void> => {
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    if (entry.isDirectory()) await seal(join(folder, entry.name));
  }
  await chmod(folder, 0o555);
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
    await seal(staging);
    await rename(staging, target).catch(async (error: NodeJS.ErrnoException) => {
      // Another import of the same content won the race; its folder holds the same files.
      if (!(await exists(target))) throw error;
    });
    return target;
  } finally {
    if (await exists(staging)) {
      await chmodTree(staging);
      await rm(staging, { recursive: true, force: true });
    }
  }
};

/** Lets a staging folder be removed again after `seal`. */
const chmodTree = async (folder: string): Promise<void> => {
  await chmod(folder, 0o755);
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    if (entry.isDirectory()) await chmodTree(join(folder, entry.name));
  }
};

/** The object store under `skills` in `dataFolder`, with `SkillFiles` for the hub to read it. */
export const SkillObjectsLive = (dataFolder: string) => {
  const root = join(dataFolder, "skills", "objects");
  const objects = Layer.effect(
    SkillObjects,
    Effect.gen(function* () {
      yield* Effect.promise(() => mkdir(root, { recursive: true, mode: 0o700 }));
      const folder = (hash: SkillRevisionHash) =>
        Effect.promise(async () => ((await exists(join(root, hash))) ? join(root, hash) : null));
      return SkillObjects.of({
        root,
        folder,
        put: (hash, contents) => Effect.promise(() => write(root, hash, contents)),
      });
    }),
  );
  const files = Layer.effect(
    SkillFiles,
    Effect.gen(function* () {
      const store = yield* SkillObjects;
      return SkillFiles.of({ folder: store.folder });
    }),
  );
  return Layer.provideMerge(files, objects);
};
