import type { FolderChecksShape } from "@hobbots/agents";
import type { QuestLimits, TaskToolRefused } from "@hobbots/domain";
import { Effect } from "effect";
import { holds, type PathSeparator } from "./authority.ts";
import { refuse } from "./call-scope.ts";

/**
 * The folders a member gets when its lead names none (#582, ADR 018): the narrowest the work
 * needs, never every folder the lead can reach. Those are the folders the brief names that are the
 * lead's or inside one, or else the folder the lead's own Task works in, the first of its folders,
 * which is where its turns start. A lead that wants the member to have all of its folders says so.
 */

/** Characters a path in a brief ends before, such as the quote or bracket around it. */
const AROUND = new Set([..." \t\r\n\f\v\"'`()<>[]{}"]);
const QUOTES = ['"', "'", "`"];
/** A sentence's own punctuation after a path, as in "work in /site/docs.", which is not part of it. */
const PUNCTUATION = new Set([...".,;:!?"]);

/** For each position of `text`, where the next `char` or line end is: one backward pass. */
const nextOf = (text: string, char: string): Int32Array => {
  const next = new Int32Array(text.length + 1).fill(text.length);
  for (let i = text.length - 1; i >= 0; i--)
    next[i] = text[i] === char || text[i] === "\n" ? i : (next[i + 1] as number);
  return next;
};

/** Whether an absolute path starts at `i`: `/` on a hub that divides at it, else a drive such as `C:\`. */
const startsAt = (text: string, i: number, separator: PathSeparator) =>
  separator === "/" ? text[i] === "/" : /[A-Za-z]/.test(text[i] ?? "") && text[i + 1] === ":" && text[i + 2] === "\\";

/**
 * Absolute paths written in `text`, as typed, for a hub whose paths divide at `separator`. A path in
 * quotes runs to its closing quote on the same line, spaces and all; any other ends before a space,
 * quote or bracket, without a sentence's punctuation after it. One pass over the text, whatever it
 * holds (STD-SEC-005).
 */
export const pathsIn = (text: string, separator: PathSeparator): ReadonlyArray<string> => {
  const closing = new Map(QUOTES.map((quote) => [quote, nextOf(text, quote)]));
  const found: Array<string> = [];
  let i = 0;
  while (i < text.length) {
    const before = text[i - 1];
    if ((i > 0 && !AROUND.has(before as string)) || !startsAt(text, i, separator)) {
      i++;
      continue;
    }
    const close = closing.get(before as string)?.[i];
    if (close !== undefined && text[close] === before) {
      found.push(text.slice(i, close));
      i = close;
      continue;
    }
    let end = i;
    while (end < text.length && !AROUND.has(text[end] as string)) end++;
    let kept = end;
    while (kept > i && PUNCTUATION.has(text[kept - 1] as string)) kept--;
    found.push(text.slice(i, kept));
    i = end;
  }
  return [...new Set(found)].filter((path) => path.length > 1);
};

/** Each existing folder `text` names inside one of `lead`, as the hub stores it. */
export const namedFolders = (
  checks: FolderChecksShape,
  lead: ReadonlyArray<string>,
  text: string,
  separator: PathSeparator,
) =>
  Effect.gen(function* () {
    const named = yield* Effect.forEach(
      pathsIn(text, separator),
      (path) => checks.check(path).pipe(Effect.orElseSucceed(() => null)),
      { concurrency: 8 },
    );
    return [
      ...new Set(
        named.filter(
          (folder): folder is string => folder !== null && lead.some((own) => holds(own, folder, separator)),
        ),
      ),
    ];
  });

/** The folder `path` sits in, on a hub whose paths divide at `separator`; none for a root. */
const parentOf = (path: string, separator: PathSeparator): string | null => {
  const trimmed = path.endsWith(separator) ? path.slice(0, -separator.length) : path;
  const at = trimmed.lastIndexOf(separator);
  if (at <= 0) return null;
  // A drive's root keeps its separator: `C:\`.
  return separator === "\\" && at === 2 ? trimmed.slice(0, 3) : trimmed.slice(0, at);
};

/**
 * The folder each path `text` names sits in, for a path that is not a folder itself, such as a file
 * the work writes or reads: as the hub stores it, when it exists inside one of `lead`. Only the
 * folder right above it counts, so a path never widens to a folder far above what it names (#1181).
 */
const namedParents = (checks: FolderChecksShape, lead: ReadonlyArray<string>, text: string, separator: PathSeparator) =>
  Effect.gen(function* () {
    const found = yield* Effect.forEach(
      pathsIn(text, separator),
      (path) =>
        Effect.gen(function* () {
          const folder = yield* checks.check(path).pipe(Effect.orElseSucceed(() => null));
          if (folder !== null) return null;
          const parent = parentOf(path, separator);
          return parent === null ? null : yield* checks.check(parent).pipe(Effect.orElseSucceed(() => null));
        }),
      { concurrency: 8 },
    );
    return [
      ...new Set(
        found.filter(
          (folder): folder is string => folder !== null && lead.some((own) => holds(own, folder, separator)),
        ),
      ),
    ];
  });

/** The folders the work the brief describes is in: those it names, and those the files it names sit in. */
export const briefTargets = (
  checks: FolderChecksShape,
  lead: ReadonlyArray<string>,
  brief: string,
  separator: PathSeparator,
) =>
  Effect.map(
    Effect.all([namedFolders(checks, lead, brief, separator), namedParents(checks, lead, brief, separator)]),
    ([folders, parents]) => ({ folders, parents }),
  );

/**
 * The member's default folders: each existing folder the brief names inside one of the lead's,
 * as the hub stores it, or else the lead's first folder, and with them the folder each file the
 * brief names sits in when none of those holds it, so a member told to write
 * `/docs/out/page.html` can (#1181). None when the lead has none.
 */
export const defaultFolders = (
  checks: FolderChecksShape,
  lead: ReadonlyArray<string>,
  brief: string,
  separator: PathSeparator,
) =>
  Effect.map(briefTargets(checks, lead, brief, separator), ({ folders, parents }) => {
    const base = folders.length > 0 ? folders : lead.slice(0, 1);
    const extra = parents.filter((parent) => !base.some((folder) => holds(folder, parent, separator)));
    return [...base, ...new Set(extra)];
  });

/** Of `targets`, those none of `folders` holds: where a member was asked to work but cannot. */
export const outOfReach = (
  targets: ReadonlyArray<string>,
  folders: ReadonlyArray<string>,
  separator: PathSeparator,
): ReadonlyArray<string> => targets.filter((target) => !folders.some((folder) => holds(folder, target, separator)));

/** The folders a lead names for its Quest's work (#670), as the hub stores them: each one of its own or inside one. */
export const requestedFolders = (
  checks: FolderChecksShape,
  lead: ReadonlyArray<string>,
  requested: ReadonlyArray<string>,
  separator: PathSeparator,
): Effect.Effect<ReadonlyArray<string>, TaskToolRefused> =>
  Effect.map(
    Effect.forEach(requested, (typed) =>
      checks.check(typed).pipe(
        Effect.catch(() => refuse("invalid-input", `${typed} is not a folder on this hub.`)),
        Effect.filterOrElse(
          (folder) => lead.some((own) => holds(own, folder, separator)),
          () => refuse("authority-wider", `${typed} is not one of your folders or inside one.`),
        ),
      ),
    ),
    (folders) => [...new Set(folders)],
  );

/** A Quest's limits with the folders its work is in (#670); none leaves all of its lead's. */
export const withFolders = (limits: QuestLimits, folders: ReadonlyArray<string>): QuestLimits =>
  folders.length === 0 ? limits : { ...limits, folders };
