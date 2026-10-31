import { Effect } from "effect";
import type { FolderChecksShape } from "./ports.ts";

/** Whether `folder` is one of `among`, by spelling or by the folder each names now. */
export const sameFolderIn = (folders: FolderChecksShape, among: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const identities = new Set([...among, ...(yield* Effect.forEach(among, folders.identity))]);
    return (folder: string) =>
      Effect.map(folders.identity(folder), (identity) => identities.has(folder) || identities.has(identity));
  });
