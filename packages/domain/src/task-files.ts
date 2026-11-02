import { Schema } from "effect";
import { type AttemptActivity, type FileChange, isImageFile, isSecretFile } from "./activity.ts";
import { AttemptId } from "./task.ts";

/**
 * The files a Task made or touched, as the Workbench's Files tab lists them (ADR 023): its file
 * Artifact references and every file it added, edited or moved, each with how it is now. Only files
 * inside the hob's folders are listed or served.
 */

/** A listed file's id: its Artifact reference's id, else the id of its latest change. */
export const TaskFileId = Schema.String.pipe(Schema.brand("TaskFileId"));
export type TaskFileId = typeof TaskFileId.Type;

/** How the Files tab previews a file. `none`: it shows the file's name, size and kind only. */
export const FilePreview = Schema.Literals(["image", "pdf", "markdown", "text", "none"]);
export type FilePreview = typeof FilePreview.Type;

/** How the file came into the Task: `made` when the Task named it as a result, else its latest change. */
export const TaskFileOrigin = Schema.Literals(["made", "added", "edited", "moved"]);
export type TaskFileOrigin = typeof TaskFileOrigin.Type;

/**
 * The file as it is now, against what the Task left. `changed`: it no longer holds what the Task
 * left. `unchecked`: it is the size the Task left, but too large for the hub to read, so whether it
 * still holds the same was not checked. `gone`: it is no longer there, or is no longer a file the
 * hub may read.
 */
export const TaskFileNow = Schema.Literals(["same", "changed", "unchecked", "gone"]);
export type TaskFileNow = typeof TaskFileNow.Type;

/** Why a file's contents are not served. `secret`: its name marks it as one that may hold secrets. */
export const FileNotServed = Schema.Literals(["secret", "too-large"]);
export type FileNotServed = typeof FileNotServed.Type;

export class TaskFile extends Schema.Class<TaskFile>("TaskFile")({
  id: TaskFileId,
  /** The hob's folder it is in, canonical. */
  folder: Schema.String,
  /** Its path inside the folder, with `/` between names. */
  path: Schema.String,
  /** Where it is on the hub: the folder and path joined. */
  location: Schema.String,
  /** The name the Task gave it as a result, when it did. */
  label: Schema.NullOr(Schema.String),
  origin: TaskFileOrigin,
  preview: FilePreview,
  /** Its size now, or the size the Task left when it is gone. */
  size: Schema.NullOr(Schema.Number),
  now: TaskFileNow,
  /** The SHA-256 of what it holds now, a preview's version: null when it is gone or too large to serve. */
  hash: Schema.NullOr(Schema.String),
  /** Why its contents are not served, or null when they are. */
  notServed: Schema.NullOr(FileNotServed),
}) {}

/** The files an Attempt made or touched, read from the hub's records and the hob's folders now. */
export class AttemptFiles extends Schema.Class<AttemptFiles>("AttemptFiles")({
  attemptId: AttemptId,
  files: Schema.Array(TaskFile),
}) {}

/** The most the hub serves of one file, for a preview or a download; past it, Show in Finder still works. */
export const SERVED_FILE_BYTES = 64 * 1024 * 1024;

/** The most of a text file a preview shows, as the Changes tab keeps (ADR 023). */
export const PREVIEW_TEXT_BYTES = 1024 * 1024;

const extensionOf = (path: string) => {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return { name: name.toLowerCase(), extension: dot <= 0 ? "" : name.slice(dot + 1).toLowerCase() };
};

const MARKDOWN = new Set(["md", "markdown", "mdx"]);

/** Plain text by its extension: prose, data, configuration and source code. */
const TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
  "txt",
  "text",
  "log",
  "csv",
  "tsv",
  "json",
  "jsonl",
  "yaml",
  "yml",
  "toml",
  "ini",
  "cfg",
  "conf",
  "xml",
  "html",
  "htm",
  "css",
  "scss",
  "svg",
  "js",
  "mjs",
  "cjs",
  "jsx",
  "ts",
  "mts",
  "cts",
  "tsx",
  "py",
  "rb",
  "go",
  "rs",
  "java",
  "kt",
  "swift",
  "c",
  "h",
  "cc",
  "cpp",
  "hpp",
  "cs",
  "php",
  "sh",
  "bash",
  "zsh",
  "fish",
  "sql",
  "graphql",
  "lua",
  "r",
  "tex",
  "rst",
  "adoc",
  "org",
  "diff",
  "patch",
]);

/** Text files known by their whole name. */
const TEXT_NAMES: ReadonlySet<string> = new Set([
  "readme",
  "license",
  "changelog",
  "makefile",
  "dockerfile",
  "gemfile",
  "procfile",
  ".gitignore",
  ".editorconfig",
]);

/**
 * How a file is previewed, by its name: images Hobbots shows (PNG, JPEG, GIF, WebP), PDF, Markdown
 * and plain text. An SVG is previewed as its text, never drawn, since it can carry script.
 */
export const previewOf = (path: string): FilePreview => {
  if (isImageFile(path)) return "image";
  const { name, extension } = extensionOf(path);
  if (extension === "pdf") return "pdf";
  if (MARKDOWN.has(extension)) return "markdown";
  if (TEXT_EXTENSIONS.has(extension) || TEXT_NAMES.has(name)) return "text";
  return "none";
};

/** The media type a previewed file is served with; anything else is served only as a download. */
export const previewMediaType = (path: string): string | null => {
  switch (previewOf(path)) {
    case "image": {
      const { extension } = extensionOf(path);
      return extension === "jpg" ? "image/jpeg" : `image/${extension}`;
    }
    case "pdf":
      return "application/pdf";
    case "markdown":
    case "text":
      return "text/plain; charset=utf-8";
    default:
      return null;
  }
};

/** A file the Task named or changed, before the hub looks at it now. */
export interface FileCandidate {
  readonly id: TaskFileId;
  readonly folder: string;
  readonly path: string;
  readonly label: string | null;
  readonly origin: TaskFileOrigin;
  /** What the Task left in it, when a change recorded it: its hash and size. */
  readonly left: { readonly hash: string; readonly size: number } | null;
}

/** Where a file Artifact reference points, inside one of the hob's folders: resolved by the hub. */
export interface PlacedArtifact {
  readonly artifactId: string;
  readonly label: string;
  readonly folder: string;
  readonly path: string;
}

const keyOf = (folder: string, path: string) => `${folder}\0${path}`;

/** By path, then by folder. */
const byPlace = (a: { folder: string; path: string }, b: { folder: string; path: string }) =>
  a.path < b.path ? -1 : a.path > b.path ? 1 : a.folder < b.folder ? -1 : a.folder > b.folder ? 1 : 0;

/** Joins a folder and a `/`-separated path inside it. */
export const fileLocation = (folder: string, path: string) =>
  folder.endsWith("/") || folder.endsWith("\\") ? `${folder}${path}` : `${folder}/${path}`;

/** The latest change of each path that left a file there: links and deletions leave none to show. */
const latestChanges = (changes: ReadonlyArray<FileChange>): ReadonlyMap<string, FileChange> => {
  const latest = new Map<string, FileChange>();
  for (const change of changes) {
    const key = keyOf(change.folder, change.path);
    const known = latest.get(key);
    if (known === undefined || change.recordedAt >= known.recordedAt) latest.set(key, change);
  }
  for (const [key, change] of latest) {
    if (change.after === null || change.kind === "link" || change.kind === "deleted") latest.delete(key);
  }
  return latest;
};

/**
 * The files an Attempt made or touched, in order: the ones it named as results first, then the
 * ones it changed, each by path. A file named and changed is listed once, as made,
 * with what its change left. `placed` are its file Artifact references the hub found inside the
 * hob's folders; any other is not listed.
 */
export const fileCandidates = (
  activity: Pick<AttemptActivity, "changes">,
  placed: ReadonlyArray<PlacedArtifact>,
): ReadonlyArray<FileCandidate> => {
  const changes = latestChanges(activity.changes);
  const leftBy = (change: FileChange | undefined) =>
    change?.after == null ? null : { hash: change.after.hash, size: change.after.size };
  const listed = new Set<string>();
  const made: Array<FileCandidate> = [];
  for (const artifact of [...placed].sort(byPlace)) {
    const key = keyOf(artifact.folder, artifact.path);
    if (listed.has(key)) continue;
    listed.add(key);
    made.push({
      id: TaskFileId.make(artifact.artifactId),
      folder: artifact.folder,
      path: artifact.path,
      label: artifact.label,
      origin: "made",
      left: leftBy(changes.get(key)),
    });
  }
  const touched = [...changes]
    .filter(([key]) => !listed.has(key))
    .map(([, change]) => change)
    .sort(byPlace)
    .map(
      (change): FileCandidate => ({
        id: TaskFileId.make(change.id),
        folder: change.folder,
        path: change.path,
        label: null,
        origin: change.kind === "added" ? "added" : change.kind === "moved" ? "moved" : "edited",
        left: leftBy(change),
      }),
    );
  return [...made, ...touched];
};

/**
 * A file as the hub found it now: its size and hash. A file larger than the hub serves is only
 * measured, never read, so it has no hash.
 */
export interface FileNow {
  readonly size: number;
  readonly hash: string | null;
}

/**
 * How a file found now compares with what the Task left: by size first, then by hash. A file of the
 * same size that was too large to hash is `unchecked`, never taken as the same.
 */
const comparedWith = (left: FileCandidate["left"], found: FileNow): TaskFileNow => {
  if (left === null) return "same";
  if (left.size !== found.size) return "changed";
  if (found.hash === null) return "unchecked";
  return left.hash === found.hash ? "same" : "changed";
};

/** A listed file, from what the Task left and what is there now. */
export const taskFile = (candidate: FileCandidate, found: FileNow | null): TaskFile => {
  const now: TaskFileNow = found === null ? "gone" : comparedWith(candidate.left, found);
  const size = found?.size ?? candidate.left?.size ?? null;
  const notServed: FileNotServed | null = isSecretFile(candidate.path)
    ? "secret"
    : size !== null && size > SERVED_FILE_BYTES
      ? "too-large"
      : null;
  return new TaskFile({
    id: candidate.id,
    folder: candidate.folder,
    path: candidate.path,
    location: fileLocation(candidate.folder, candidate.path),
    label: candidate.label,
    origin: candidate.origin,
    preview: notServed === "secret" ? "none" : previewOf(candidate.path),
    size,
    now,
    hash: found?.hash ?? null,
    notServed,
  });
};
