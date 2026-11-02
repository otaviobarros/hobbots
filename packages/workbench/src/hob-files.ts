import { realpath } from "node:fs/promises";
import { isAbsolute, join, normalize, relative, sep } from "node:path";
import { HobFiles } from "@hobbots/agents";
import { Effect, Layer, Option } from "effect";
import { hashFile, openInside } from "./scanner.ts";

/**
 * The hob's folders as the Workbench's Files tab reads them (ADR 023). Every read opens the file
 * through no link, inside the canonical folder the hob was given, as the scanner does.
 */

/** The full path of `path` inside `folder`, or null when either is not one the hub reads. */
const fullPath = (folder: string, path: string): string | null => {
  const parts = path.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) return null;
  // The folder as the hob was given it, canonical, never resolved again.
  if (!isAbsolute(folder) || normalize(folder) !== folder) return null;
  return join(folder, ...parts);
};

const inside = (target: string, folder: string) =>
  target !== folder && target.startsWith(folder.endsWith(sep) ? folder : `${folder}${sep}`);

/**
 * Where `value` sits among `folders`: every link resolved, as the policy resolves a path (ADR 014),
 * a relative path against the first folder. A path that does not exist now is placed by its
 * spelling, so a file since deleted still lists, as gone; it is never read.
 */
const place = async (folders: ReadonlyArray<string>, value: string) => {
  const first = folders[0];
  if (first === undefined) return null;
  const spelled = isAbsolute(value) ? normalize(value) : join(first, value);
  const target = (await realpath(spelled).catch(() => null)) ?? spelled;
  // The innermost folder holding it, when one folder sits inside another.
  const folder = folders
    .filter((each) => inside(target, each))
    .sort((a, b) => b.length - a.length)
    .at(0);
  if (folder === undefined) return null;
  return { folder, path: relative(folder, target).split(sep).join("/") };
};

const look = async (folder: string, path: string) => {
  const full = fullPath(folder, path);
  if (full === null) return null;
  const handle = await openInside(folder, full);
  if (handle === null) return null;
  const size = await handle
    .stat()
    .then((stats) => stats.size)
    .finally(() => handle.close());
  const hash = await hashFile(folder, full);
  return hash === null ? null : { size, hash };
};

const read = async (folder: string, path: string, maxBytes: number) => {
  const full = fullPath(folder, path);
  if (full === null) return null;
  const handle = await openInside(folder, full);
  if (handle === null) return null;
  try {
    const buffer = new Uint8Array(maxBytes);
    let filled = 0;
    while (filled < maxBytes) {
      const { bytesRead } = await handle.read(buffer, filled, maxBytes - filled, filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    return buffer.subarray(0, filled);
  } finally {
    await handle.close();
  }
};

const optional = <A>(run: () => Promise<A | null>) =>
  Effect.tryPromise(run).pipe(
    Effect.map(Option.fromNullishOr),
    Effect.orElseSucceed(() => Option.none<A>()),
  );

export const makeHobFiles = () =>
  HobFiles.of({
    place: (folders, value) => optional(() => place(folders, value)),
    look: (folder, path) => optional(() => look(folder, path)),
    read: (folder, path, maxBytes) => optional(() => read(folder, path, maxBytes)),
  });

/** The hub's reads of the hob's folders for the Files tab. */
export const HobFilesLive = Layer.sync(HobFiles, makeHobFiles);
