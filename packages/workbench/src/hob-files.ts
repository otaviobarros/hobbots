import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute, join, normalize, relative, sep } from "node:path";
import { HobFiles } from "@hobbots/agents";
import { SERVED_FILE_BYTES } from "@hobbots/domain";
import { openFileIn } from "@hobbots/permissions";
import { Effect, Layer, Option } from "effect";
import { type Seen, unchangedSince } from "./scanner.ts";

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

/** How many looks are remembered: past it the oldest is forgotten and hashed again when asked. */
const REMEMBERED_LOOKS = 4096;

/**
 * The size and SHA-256 of the file one open reaches. A file larger than the hub serves is never
 * read, only measured: it has no hash. Any other is read through only when it may have changed since
 * it was last hashed: an earlier look of the same file, unchanged in inode, size and times since well
 * before that look began, is reused, as the scanner reuses its own.
 */
const lookWith = (seen: Map<string, Seen>) => async (folder: string, path: string) => {
  const startNs = BigInt(Date.now()) * 1_000_000n;
  const handle = await openFileIn(folder, path);
  if (handle === null) return null;
  try {
    const key = `${folder}\0${path}`;
    const stats = await handle.stat({ bigint: true });
    if (stats.size > BigInt(SERVED_FILE_BYTES)) return { size: Number(stats.size), hash: null };
    const before = seen.get(key);
    if (unchangedSince(before, stats)) return { size: Number(stats.size), hash: before.hash };
    const hash = createHash("sha256");
    let size = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false, start: 0, end: SERVED_FILE_BYTES })) {
      hash.update(chunk as Uint8Array);
      size += (chunk as Uint8Array).length;
    }
    // It grew past what the hub serves while it was read.
    if (size > SERVED_FILE_BYTES) return { size, hash: null };
    const digest = hash.digest("hex");
    seen.delete(key);
    // What was read is what the stats describe only when its size agrees with them.
    if (BigInt(size) === stats.size) {
      seen.set(key, {
        ino: stats.ino,
        size: stats.size,
        mtimeNs: stats.mtimeNs,
        ctimeNs: stats.ctimeNs,
        hash: digest,
        scanStartNs: startNs,
      });
      if (seen.size > REMEMBERED_LOOKS) seen.delete(seen.keys().next().value as string);
    }
    return { size, hash: digest };
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

export const makeHobFiles = () => {
  const look = lookWith(new Map());
  return HobFiles.of({
    place: (folders, value) => optional(() => place(folders, value)),
    look: (folder, path) => optional(() => look(folder, path)),
    read: (folder, path, maxBytes) => optional(() => read(folder, path, maxBytes)),
  });
};

/** The hub's reads of the hob's folders for the Files tab. */
export const HobFilesLive = Layer.sync(HobFiles, makeHobFiles);
