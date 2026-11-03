import type { FolderChecksShape } from "@hobbots/agents";
import { Effect } from "effect";
import { holds, type PathSeparator } from "./authority.ts";

/**
 * The folders a member gets when its lead names none (#582, ADR 018): the narrowest the work
 * needs, never every folder the lead can reach. Those are the folders the brief names that are the
 * lead's or inside one, or else the folder the lead's own Task works in, the first of its folders,
 * which is where its turns start. A lead that wants the member to have all of its folders says so.
 */

/** Characters a path in a brief ends before, such as the quote or bracket around it. */
const AROUND = String.raw`\s"'\`()<>\[\]{}`;

/** Absolute paths written in `text`, as typed, for a hub whose paths divide at `separator`. */
export const pathsIn = (text: string, separator: PathSeparator): ReadonlyArray<string> => {
  const start = separator === "/" ? String.raw`\/` : String.raw`[A-Za-z]:\\`;
  const found = text.matchAll(new RegExp(`(?:^|[${AROUND}])(${start}[^${AROUND}]*)`, "g"));
  // A sentence's own punctuation after a path, as in "work in /site/docs.", is not part of it.
  return [...new Set([...found].map((match) => (match[1] ?? "").replace(/[.,;:!?]+$/, "")))].filter(
    (path) => path.length > 1,
  );
};

/**
 * The member's default folders: each existing folder the brief names inside one of the lead's,
 * as the hub stores it, or else the lead's first folder. None when the lead has none.
 */
export const defaultFolders = (
  checks: FolderChecksShape,
  lead: ReadonlyArray<string>,
  brief: string,
  separator: PathSeparator,
) =>
  Effect.gen(function* () {
    const named = yield* Effect.forEach(pathsIn(brief, separator), (path) =>
      checks.check(path).pipe(Effect.orElseSucceed(() => null)),
    );
    const inside = [
      ...new Set(
        named.filter(
          (folder): folder is string => folder !== null && lead.some((own) => holds(own, folder, separator)),
        ),
      ),
    ];
    if (inside.length > 0) return inside;
    return lead.slice(0, 1);
  });
