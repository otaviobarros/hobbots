import type { AgentId, AttemptActivity, FileChange, FileChangeKind, FileVersion } from "@hobbots/domain";
import { diffArrays, diffLines } from "diff";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

/**
 * How the Changes tab shows a file (ADR 023): a document rendered before and after, code and other
 * text as a diff, an image side by side, a link by where it points, and anything else by its name,
 * size and kind.
 */
export type ChangeShow = "document" | "code" | "image" | "link" | "other";

const DOCUMENT_EXTENSIONS: ReadonlySet<string> = new Set(["md", "markdown", "mdown", "mkd", "mdx"]);

const extensionOf = (path: string) => {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
};

const versionsOf = (change: FileChange): ReadonlyArray<FileVersion> =>
  [change.before, change.after].filter((each): each is FileVersion => each !== null);

export const changeShow = (change: FileChange): ChangeShow => {
  const versions = versionsOf(change);
  if (change.kind === "link" || versions.some((each) => each.kind === "link")) return "link";
  if (versions.some((each) => each.kind === "image")) return "image";
  if (versions.length === 0 || versions.some((each) => each.kind !== "text")) return "other";
  return DOCUMENT_EXTENSIONS.has(extensionOf(change.path)) ? "document" : "code";
};

/** Where a change is on the hub: its folder and its path inside it. */
export const changePath = (change: Pick<FileChange, "folder" | "path">): string =>
  change.folder.endsWith("/") ? `${change.folder}${change.path}` : `${change.folder}/${change.path}`;

/** Whether a change left a file that Files lists: not a deletion, and not a link, which is never followed. */
export const leavesFile = (change: FileChange): boolean =>
  change.kind !== "deleted" && change.kind !== "link" && change.after !== null && change.after.kind !== "link";

/** A path split into its folders and its name, so a list can show the name first. */
export const splitPath = (path: string): { readonly dir: string; readonly name: string } => {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? { dir: "", name: path } : { dir: path.slice(0, slash + 1), name: path.slice(slash + 1) };
};

/** The kind of a file as a person reads it: its extension in capitals, or null when it has none. */
export const fileKindLabel = (path: string): string | null => {
  const extension = extensionOf(path);
  return extension === "" ? null : extension.toUpperCase();
};

/** How many changes of each kind, for the line above the list. */
export const changeCounts = (changes: ReadonlyArray<FileChange>): Readonly<Record<FileChangeKind, number>> => {
  const counts: Record<FileChangeKind, number> = { added: 0, edited: 0, deleted: 0, moved: 0, link: 0 };
  for (const change of changes) counts[change.kind] += 1;
  return counts;
};

/**
 * The change the tab shows: the one asked for by its path on the hub (a link from Summary), else
 * the one picked in the list, else the first.
 */
export const selectedChange = (
  changes: ReadonlyArray<FileChange>,
  picked: string | null,
  focus: string | undefined,
): FileChange | null =>
  (focus === undefined ? undefined : changes.find((each) => changePath(each) === focus)) ??
  changes.find((each) => each.id === picked) ??
  changes[0] ??
  null;

/** The hobs that worked in the same folder while a change was made, for "Changed while Ada was also working here". */
export const sharedHobs = (change: FileChange, activity: AttemptActivity): ReadonlyArray<AgentId> => {
  const hobs = new Set<AgentId>();
  for (const attemptId of change.sharedWith) {
    const found = activity.sharedWithHobs.find((each) => each.attemptId === attemptId);
    if (found !== undefined && found.agentId !== activity.attempt.agentId) hobs.add(found.agentId);
  }
  return [...hobs];
};

/** One line of a diff. */
export interface DiffLine {
  readonly kind: "same" | "added" | "removed";
  /** The line's number before and after; null on the side it is not on. */
  readonly before: number | null;
  readonly after: number | null;
  readonly text: string;
}

/** One line of a diff, or a run of unchanged lines folded away. */
export type DiffRow =
  | DiffLine
  | {
      readonly kind: "folded";
      readonly lines: number;
      /** The unchanged lines it folds away, to show when it is opened. */
      readonly hidden: ReadonlyArray<DiffLine>;
    };

export interface CodeDiff extends LineCounts {
  readonly rows: ReadonlyArray<DiffRow>;
}

/** A text's lines, without the empty one after a final line break. */
const linesOf = (text: string): ReadonlyArray<string> => {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
};

/** How long a diff may take before it gives up and shows the whole of each side. */
const DIFF_TIMEOUT_MS = 1_000;

/** Each line of `before` and `after` as one row, numbered on each side. */
const lineRows = (before: string, after: string): ReadonlyArray<DiffLine> => {
  const parts = diffLines(before, after, { timeout: DIFF_TIMEOUT_MS }) ?? [
    { value: before, added: false, removed: true, count: 0 },
    { value: after, added: true, removed: false, count: 0 },
  ];
  const rows: Array<DiffLine> = [];
  let was = 0;
  let now = 0;
  for (const part of parts) {
    for (const text of linesOf(part.value)) {
      if (part.added) rows.push({ kind: "added", before: null, after: ++now, text });
      else if (part.removed) rows.push({ kind: "removed", before: ++was, after: null, text });
      else rows.push({ kind: "same", before: ++was, after: ++now, text });
    }
  }
  return rows;
};

/**
 * For each line, whether a change is within `context` lines of it: one pass from each end, each
 * keeping the distance to the nearest change on its side, so a large file folds in linear time.
 */
const nearChanges = (lines: ReadonlyArray<{ readonly kind: DiffRow["kind"] }>, context: number): Array<boolean> => {
  const near = new Array<boolean>(lines.length).fill(false);
  let since = Number.POSITIVE_INFINITY;
  for (let index = 0; index < lines.length; index++) {
    since = lines[index]?.kind === "same" ? since + 1 : 0;
    near[index] = since <= context;
  }
  let until = Number.POSITIVE_INFINITY;
  for (let index = lines.length - 1; index >= 0; index--) {
    until = lines[index]?.kind === "same" ? until + 1 : 0;
    if (until <= context) near[index] = true;
  }
  return near;
};

/**
 * A line diff of two versions of a text file, with unchanged runs folded to `context` lines around
 * each change. A missing side is empty: an added file is all added lines, a deleted one all
 * removed. A diff that takes too long shows the whole of each side instead.
 */
export const codeDiff = (before: string | null, after: string | null, context: number = 3): CodeDiff => {
  const lines = lineRows(before ?? "", after ?? "");
  return { rows: foldLines(lines, context), ...countRows(lines) };
};

/** How many lines a change added and removed. */
export interface LineCounts {
  readonly added: number;
  readonly removed: number;
}

const countRows = (lines: ReadonlyArray<DiffRow>): LineCounts => ({
  added: lines.filter((row) => row.kind === "added").length,
  removed: lines.filter((row) => row.kind === "removed").length,
});

/** The lines a change to a text file added and removed, as its diff counts them. */
export const lineCounts = (before: string | null, after: string | null): LineCounts =>
  countRows(lineRows(before ?? "", after ?? ""));

/** A diff's lines with each unchanged run more than `context` lines from a change folded into one row. */
export const foldLines = (lines: ReadonlyArray<DiffLine>, context: number): ReadonlyArray<DiffRow> => {
  const near = nearChanges(lines, context);
  const rows: Array<DiffRow> = [];
  let hidden: Array<DiffLine> = [];
  const fold = () => {
    if (hidden.length > 0) rows.push({ kind: "folded", lines: hidden.length, hidden });
    hidden = [];
  };
  for (const [index, row] of lines.entries()) {
    if (row.kind === "same" && !near[index]) {
      hidden.push(row);
      continue;
    }
    fold();
    rows.push(row);
  }
  fold();
  return rows;
};

/** How a top-level block of a document changed. */
export type BlockMark = "added" | "removed";

/**
 * One version of a document with the top-level blocks the change touched, by where each starts in
 * its text. The whole document is rendered at once, so links, images and footnotes that refer to a
 * definition elsewhere in it still resolve.
 */
export interface MarkedDocument {
  readonly text: string;
  readonly marks: ReadonlyMap<number, BlockMark>;
}

const markdown = unified().use(remarkParse).use(remarkGfm);

/** A Markdown document's top-level blocks (headings, paragraphs, lists, tables, code), with where each starts. */
export const documentBlocks = (text: string): ReadonlyArray<{ readonly start: number; readonly text: string }> =>
  markdown.parse(text).children.flatMap((node) =>
    node.position?.start.offset === undefined || node.position.end.offset === undefined
      ? []
      : [
          {
            start: node.position.start.offset,
            text: text.slice(node.position.start.offset, node.position.end.offset),
          },
        ],
  );

/**
 * Two versions of a document, block by block: the earlier one with the blocks the change removed
 * marked, the later one with those it added. An edited block is one removed and one added. A
 * version shown alone, as for an added or deleted file, has nothing to be marked against.
 */
export const documentDiff = (
  before: string | null,
  after: string | null,
): { readonly before: MarkedDocument | null; readonly after: MarkedDocument | null } => {
  if (before === null || after === null) {
    const alone = (text: string | null) => (text === null ? null : { text, marks: new Map<number, BlockMark>() });
    return { before: alone(before), after: alone(after) };
  }
  const was = documentBlocks(before);
  const now = documentBlocks(after);
  const parts = diffArrays([...was], [...now], {
    comparator: (a, b) => a.text.trim() === b.text.trim(),
    timeout: DIFF_TIMEOUT_MS,
  }) ?? [
    { value: [...was], added: false, removed: true, count: was.length },
    { value: [...now], added: true, removed: false, count: now.length },
  ];
  const removed = new Map<number, BlockMark>();
  const added = new Map<number, BlockMark>();
  for (const part of parts) {
    if (part.added) for (const block of part.value) added.set(block.start, "added");
    else if (part.removed) for (const block of part.value) removed.set(block.start, "removed");
  }
  return { before: { text: before, marks: removed }, after: { text: after, marks: added } };
};
