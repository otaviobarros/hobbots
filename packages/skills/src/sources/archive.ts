import { Buffer } from "node:buffer";
import type { Readable } from "node:stream";
import { trimTrailingSlashes } from "@hobbots/domain";
import yauzl from "yauzl";
import { type SkillTree, TREE_ENTRIES_MAX, type TreeEntry, TreeUnreadable } from "../tree.ts";

/** The most an archive may be, in bytes, before it is read at all. */
export const ARCHIVE_BYTES_MAX = 50 * 1024 * 1024;

const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;
const S_IFDIR = 0o040000;

/** What the Unix mode in an entry's attributes says it is; zips made elsewhere carry none. */
const kindOf = (name: string, attributes: number): TreeEntry["kind"] => {
  const type = (attributes >>> 16) & S_IFMT;
  if (type === S_IFLNK) return "symlink";
  if (type === S_IFDIR || name.endsWith("/")) return "directory";
  return type === 0 || type === 0o100000 ? "file" : "other";
};

const collect = async (stream: Readable): Promise<Uint8Array> => {
  const chunks: Array<Buffer> = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks);
};

/**
 * A `.zip` or `.skill` archive, read from memory and never unpacked to disk. Names are read as they
 * are, not cleaned, so a name that reaches outside the skill is listed for the checks to refuse.
 * Sizes are checked against what each entry says it holds.
 */
export const archiveTree = async (bytes: Uint8Array): Promise<SkillTree> => {
  if (bytes.byteLength > ARCHIVE_BYTES_MAX) throw new TreeUnreadable("The archive is larger than 50 MB.");
  const zip = await yauzl
    .fromBufferPromise(Buffer.from(bytes), { lazyEntries: true, decodeStrings: false, autoClose: false })
    .catch((error: unknown) => {
      throw new TreeUnreadable(`This is not an archive Hobbots can read: ${String(error)}`);
    });
  const entries: Array<TreeEntry> = [];
  const byPath = new Map<string, yauzl.Entry>();
  try {
    for await (const entry of zip.eachEntry()) {
      // With `decodeStrings: false` the name is the archive's own bytes.
      const name = Buffer.from(entry.fileName as unknown as Uint8Array).toString("utf8");
      const kind = kindOf(name, entry.externalFileAttributes);
      const path = trimTrailingSlashes(name);
      if (path === "") continue;
      if (entry.isEncrypted()) throw new TreeUnreadable(`${path} is encrypted.`);
      entries.push({
        path,
        kind,
        executable: kind === "file" && ((entry.externalFileAttributes >>> 16) & 0o111) !== 0,
        size: kind === "file" ? entry.uncompressedSize : 0,
      });
      if (kind === "file") byPath.set(path, entry);
      if (entries.length > TREE_ENTRIES_MAX)
        throw new TreeUnreadable(`The archive holds more than ${TREE_ENTRIES_MAX} files.`);
    }
  } catch (error) {
    zip.close();
    if (error instanceof TreeUnreadable) throw error;
    throw new TreeUnreadable(`This archive cannot be read: ${String(error)}`);
  }
  return {
    entries,
    commit: null,
    read: async (path) => {
      const entry = byPath.get(path);
      if (entry === undefined) throw new TreeUnreadable(`${path} is not a file of the archive.`);
      return collect(await zip.openReadStreamPromise(entry));
    },
  };
};
