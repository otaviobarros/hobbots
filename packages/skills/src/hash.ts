import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { type SkillFileMode, SkillRevisionHash } from "@hobbots/domain";

/** A file as a revision keeps it. */
export interface SkillContent {
  readonly path: string;
  readonly mode: SkillFileMode;
  readonly bytes: Uint8Array;
}

export const sha256 = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");

/** Git's way of writing a file's mode, used in the listing so it reads the same everywhere. */
const GIT_MODE: Record<SkillFileMode, string> = { regular: "100644", executable: "100755" };

/** Sorts paths by their UTF-8 bytes, the same on every computer and locale. */
const byBytes = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));

/**
 * A revision's hash (ADR 029, Storage and revisions): the SHA-256 of a listing with one line per
 * file, sorted by path, `<mode> <SHA-256 of contents> <path>`. The same files always give the same
 * hash, whatever their order or where they came from.
 */
export const revisionHash = (files: ReadonlyArray<SkillContent>): SkillRevisionHash => {
  const lines = [...files]
    .sort((a, b) => byBytes(a.path, b.path))
    .map((file) => `${GIT_MODE[file.mode]} ${sha256(file.bytes)} ${file.path}\n`);
  return SkillRevisionHash.make(sha256(lines.join("")));
};

/**
 * The hash the `skills` CLI writes in `skills-lock.json` as `computedHash`: SHA-256 over each
 * file's relative path and then its contents, in `localeCompare` order of the paths, as its
 * `computeSkillFolderHash` does. Only used to tell whether a copy is the locked one.
 */
export const skillsCliHash = (files: ReadonlyArray<{ readonly path: string; readonly bytes: Uint8Array }>): string => {
  const hash = createHash("sha256");
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(file.path);
    hash.update(file.bytes);
  }
  return hash.digest("hex");
};
