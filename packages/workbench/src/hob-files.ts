import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute, join, normalize, relative, sep } from "node:path";
import { HobFiles } from "@hobbots/agents";
import { Effect, Layer, Option } from "effect";
import { openFileIn } from "./scanner.ts";

/**
 * The hob's folders as the Workbench's Files tab reads them (ADR 023). Every read opens the file
 * through no link, inside the canonical folder the hob was given, as the scanner does.
 */

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

/** The size and SHA-256 of what one open of the file reads, so the two always agree. */
const look = async (folder: string, path: string) => {
  const handle = await openFileIn(folder, path);
  if (handle === null) return null;
  try {
    const hash = createHash("sha256");
    let size = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      hash.update(chunk as Uint8Array);
      size += (chunk as Uint8Array).length;
    }
    return { size, hash: hash.digest("hex") };
  } finally {
    await handle.close();
  }
};

const read = async (folder: string, path: string, maxBytes: number) => {
  const handle = await openFileIn(folder, path);
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
