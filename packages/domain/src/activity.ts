import { Schema } from "effect";
import { AgentId } from "./ids.ts";
import { ArtifactRef } from "./quest.ts";
import { Attempt, AttemptId, TaskId } from "./task.ts";
import { previewToolOutput, ToolOutput } from "./tool-output.ts";

/**
 * What an Attempt did, as the Workbench shows it (ADR 023): the commands it ran, the files it
 * changed and the scans its changes were found by. The hub records these itself, from what every
 * runtime reports and from comparing the hob's folders before and after each turn, never from what
 * a hob says it did.
 */

export const CommandId = Schema.String.pipe(Schema.brand("CommandId"));
export type CommandId = typeof CommandId.Type;

export const FileChangeId = Schema.String.pipe(Schema.brand("FileChangeId"));
export type FileChangeId = typeof FileChangeId.Type;

export const FolderScanId = Schema.String.pipe(Schema.brand("FolderScanId"));
export type FolderScanId = typeof FolderScanId.Type;

/** The SHA-256 of kept contents, in hex: kept once however many records point at it. */
export const ContentId = Schema.String.pipe(Schema.brand("ContentId"));
export type ContentId = typeof ContentId.Type;

/** The limits of ADR 023. Each is configurable; these are the defaults. */
export interface ActivityLimits {
  /** A folder past this many files stops tracking changes. */
  readonly maxFiles: number;
  /** A scan that takes longer stops tracking changes for its folder. */
  readonly scanTimeoutMs: number;
  /** Text up to this size keeps its contents. */
  readonly textBytes: number;
  /** Images (PNG, JPEG, GIF, WebP) up to this size keep their contents. */
  readonly imageBytes: number;
  /** The contents an Attempt keeps at most; later changes keep their hash, size and kind only. */
  readonly contentsPerAttempt: number;
  /** A command's whole output is kept as a log up to this size; past it, its first and last halves. */
  readonly logBytes: number;
  /** The logs an Attempt keeps at most; later commands keep their first and last 8 KiB only. */
  readonly logsPerAttempt: number;
  /** How long the heavy details are kept after the top Task ends, in days. */
  readonly retentionDays: number;
}

const MiB = 1024 * 1024;

export const DEFAULT_ACTIVITY_LIMITS: ActivityLimits = {
  maxFiles: 100_000,
  scanTimeoutMs: 10_000,
  textBytes: MiB,
  imageBytes: 10 * MiB,
  contentsPerAttempt: 256 * MiB,
  logBytes: 4 * MiB,
  logsPerAttempt: 64 * MiB,
  retentionDays: 30,
};

/**
 * Why a record's details cannot be shown. `cleared`: past the retention window. `too-large`: past
 * the size kept for its kind. `not-shown`: a kind Hobbots cannot show. `secret`: a file whose name
 * marks it as secret keeps no contents. `attempt-limit`: the Attempt had kept all it may.
 * `unreadable`: the hub could not read it.
 */
export const NotKept = Schema.Literals(["cleared", "too-large", "not-shown", "secret", "attempt-limit", "unreadable"]);
export type NotKept = typeof NotKept.Type;

/**
 * A command's state. `uncertain`: its turn ended while it ran, so whether it finished is not known.
 */
export const CommandState = Schema.Literals(["running", "succeeded", "failed", "uncertain"]);
export type CommandState = typeof CommandState.Type;

/** Whether the `&` at `i` runs what comes before it in the background, rather than redirecting (`2>&1`, `&>`) or piping (`|&`). */
const background = (line: string, i: number) => !"|<>".includes(line[i - 1] ?? " ") && line[i + 1] !== ">";

/** The index just past the quoted text or escape that starts at `i`, or `i` when none starts there. */
const pastQuote = (line: string, i: number) => {
  const c = line[i];
  if (c === "\\") return i + 2;
  if (c !== "'" && c !== '"') return i;
  let j = i + 1;
  while (j < line.length && line[j] !== c) j += c === '"' && line[j] === "\\" ? 2 : 1;
  return j + 1;
};

/** Whether the character at `i`, outside quotes, ends a command whatever its exit: `;`, a newline or a lone `&`. */
const sequenceAt = (line: string, i: number) => {
  const c = line[i];
  if (c === ";" || c === "\n") return true;
  return c === "&" && line[i + 1] !== "&" && line[i - 1] !== "&" && background(line, i);
};

/**
 * The text of the quoted part of a word that opens at `j`, quotes removed, and the index past it.
 * Inside double quotes a backslash still escapes `$`, a backtick, `"` and `\\`, and joins the next line.
 */
const quotedPart = (line: string, j: number) => {
  const quote = line[j];
  let text = "";
  let k = j + 1;
  while (k < line.length && line[k] !== quote) {
    const escaped = quote === '"' && line[k] === "\\" && '$`"\\\n'.includes(line[k + 1] ?? "x");
    text += escaped && line[k + 1] === "\n" ? "" : line[escaped ? k + 1 : k];
    k += escaped ? 2 : 1;
  }
  return { text, next: k + 1 };
};

/**
 * The delimiter word of the heredoc whose `<<` ends just before `i`, after an optional `-`, with its
 * quotes and backslashes removed as the shell removes them, and the index just past it.
 */
const heredocWord = (line: string, i: number) => {
  let j = i + (line[i] === "-" ? 1 : 0);
  while (line[j] === " " || line[j] === "\t") j++;
  let word = "";
  while (j < line.length && !/[\s;&|<>()]/.test(line[j] as string)) {
    const c = line[j] as string;
    if (c === "'" || c === '"') {
      const part = quotedPart(line, j);
      word += part.text;
      j = part.next;
    } else {
      word += c === "\\" ? (line[j + 1] ?? "") : c;
      j += c === "\\" ? 2 : 1;
    }
  }
  return { word, next: j };
};

/**
 * The index of the newline that ends the last of `words`' heredoc bodies, which follow the newline
 * at `i` one after another, each up to the line that holds its delimiter alone; the line's end when
 * one is never closed.
 */
const pastBodies = (line: string, i: number, words: ReadonlyArray<string>) => {
  let end = i;
  for (const word of words) {
    do {
      const start = end + 1;
      const next = line.indexOf("\n", start);
      end = next === -1 ? line.length : next;
      if (line.slice(start, end).replace(/^\t+/, "") === word) break;
    } while (end < line.length);
  }
  return end;
};

/**
 * Whether a command line runs a command after another whatever the first one's exit: at a `;`, a
 * newline or a lone `&` outside quotes, with a command after it. Its exit code is the last
 * command's, so a line that succeeded may hold one that failed, as `git rev-parse …; git init` does
 * (#702). A heredoc's body is skipped up to its delimiter, and what follows that is read on.
 */
export const runsInSequence = (line: string): boolean => {
  const heredocs: Array<string> = [];
  for (let i = 0; i < line.length; ) {
    const past = pastQuote(line, i);
    if (past !== i) {
      i = past;
    } else if (line.startsWith("<<<", i)) {
      i += 3;
    } else if (line.startsWith("<<", i)) {
      const read = heredocWord(line, i + 2);
      heredocs.push(read.word);
      i = read.next;
    } else if (line[i] === "\n" && heredocs.length > 0) {
      // The newline after the last delimiter ends the command, and is read as any other.
      i = pastBodies(line, i, heredocs.splice(0));
    } else {
      if (sequenceAt(line, i) && line.slice(i + 1).trim() !== "") return true;
      i++;
    }
  }
  return false;
};

/** A command's whole output, kept as a log outside the database. */
export const CommandLog = Schema.Struct({
  contentId: Schema.NullOr(ContentId),
  /** UTF-8 bytes of the output, after redaction. */
  totalBytes: Schema.Number,
  /** Bytes left out between the log's first and last part; 0 when the log holds all of it. */
  omittedBytes: Schema.Number,
});
export type CommandLog = typeof CommandLog.Type;

/** A command an Attempt ran, as the Terminal shows it. */
export class CommandRecord extends Schema.Class<CommandRecord>("CommandRecord")({
  id: CommandId,
  attemptId: AttemptId,
  taskId: TaskId,
  /** The runtime's id for the call, which is also its step's. */
  stepId: Schema.String,
  /** The command line, redacted. */
  command: Schema.String,
  /** The folder it ran in. */
  folder: Schema.String,
  /** Whether it ran inside Hobbots' sandbox (ADR 014). */
  sandboxed: Schema.Boolean,
  /** Whether the runtime reports its output as it comes, or only when it ends. */
  liveOutput: Schema.Boolean,
  state: CommandState,
  /** Its exit code, when the runtime reports one. */
  exitCode: Schema.NullOr(Schema.Int),
  startedAt: Schema.String,
  endedAt: Schema.NullOr(Schema.String),
  /** What it printed, redacted, cut to its start and end; null until it ends. */
  output: Schema.NullOr(ToolOutput),
  /** Its whole output, or null when it printed nothing worth more than `output`. */
  log: Schema.NullOr(CommandLog),
  /** Why its log was not kept, when it printed more than `output` shows. */
  logNotKept: Schema.NullOr(NotKept),
}) {}

/** How a file changed. `link`: a symbolic link was added, changed or removed; it is never followed. */
export const FileChangeKind = Schema.Literals(["added", "edited", "deleted", "moved", "link"]);
export type FileChangeKind = typeof FileChangeKind.Type;

/** What a file is, as the Workbench previews it. */
export const FileKind = Schema.Literals(["text", "image", "other", "link"]);
export type FileKind = typeof FileKind.Type;

/** One side of a change: the file as it was or as it is. */
export const FileVersion = Schema.Struct({
  /** The SHA-256 of what the file held, or of a link's target. */
  hash: Schema.String,
  size: Schema.Number,
  kind: FileKind,
  /** Its kept contents, redacted when text; null when not kept, and `notKept` says why. */
  contentId: Schema.NullOr(ContentId),
  notKept: Schema.NullOr(NotKept),
});
export type FileVersion = typeof FileVersion.Type;

/** A file an Attempt added, edited, deleted or moved in one of its hob's folders. */
export class FileChange extends Schema.Class<FileChange>("FileChange")({
  id: FileChangeId,
  attemptId: AttemptId,
  taskId: TaskId,
  /** The hob's folder it is in. */
  folder: Schema.String,
  /** Its path inside the folder, with `/` between names. */
  path: Schema.String,
  kind: FileChangeKind,
  /** For a move: where it was. */
  movedFrom: Schema.NullOr(Schema.String),
  before: Schema.NullOr(FileVersion),
  after: Schema.NullOr(FileVersion),
  /** Other Attempts that worked in the same folder during the same turn, so it cannot be pinned on one. */
  sharedWith: Schema.Array(AttemptId),
  /** Whether the end-of-turn compare recorded it; until then it shows what the turn has done so far. */
  settled: Schema.Boolean,
  recordedAt: Schema.String,
}) {}

/** Why a folder's changes are not tracked. */
export const ScanStop = Schema.Literals(["too-many-files", "too-slow", "unreadable"]);
export type ScanStop = typeof ScanStop.Type;

/** A scan of one of the hob's folders, at the start or the end of a turn. */
export class FolderScan extends Schema.Class<FolderScan>("FolderScan")({
  id: FolderScanId,
  attemptId: AttemptId,
  taskId: TaskId,
  folder: Schema.String,
  phase: Schema.Literals(["start", "end"]),
  filesScanned: Schema.Int,
  /** Why tracking stopped for this folder, or null when the scan finished. */
  stopped: Schema.NullOr(ScanStop),
  startedAt: Schema.String,
  endedAt: Schema.String,
}) {}

/**
 * An Attempt's records, as the Workbench reads them. `detailsClearedAt` is set once the heavy
 * details (logs and kept contents) were cleared past the retention window.
 */
export class AttemptActivity extends Schema.Class<AttemptActivity>("AttemptActivity")({
  attempt: Attempt,
  commands: Schema.Array(CommandRecord),
  changes: Schema.Array(FileChange),
  scans: Schema.Array(FolderScan),
  /** The Task's Artifact references this Attempt made. */
  artifacts: Schema.Array(ArtifactRef),
  /** The hob of each other Attempt a change's `sharedWith` names, so a change can say who else worked there. */
  sharedWithHobs: Schema.Array(Schema.Struct({ attemptId: AttemptId, agentId: AgentId })),
  detailsClearedAt: Schema.NullOr(Schema.String),
}) {}

/** A command's whole output, redacted: all of it up to the log limit, else its first and last halves. */
export const foldLog = (text: string, limit: number = DEFAULT_ACTIVITY_LIMITS.logBytes) => {
  const folded = previewToolOutput(text, Math.floor(limit / 2));
  return {
    text: folded.omittedBytes === 0 ? folded.head : `${folded.head}${folded.tail}`,
    totalBytes: folded.totalBytes,
    omittedBytes: folded.omittedBytes,
  };
};

const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set(["png", "jpg", "jpeg", "gif", "webp"]);

/** The last name of a `/`-separated path. */
const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

const extensionOf = (name: string) => {
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
};

/** Key and certificate files that hold private keys. */
const SECRET_EXTENSIONS: ReadonlySet<string> = new Set(["pem", "key", "p12", "pfx", "keystore", "jks", "asc", "gpg"]);

/** Names of files that hold credentials whatever their contents look like. */
const SECRET_NAMES: ReadonlySet<string> = new Set([
  ".env",
  ".npmrc",
  ".pypirc",
  ".netrc",
  "_netrc",
  ".pgpass",
  "credentials",
  "credentials.json",
  ".git-credentials",
  ".htpasswd",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
]);

/**
 * Whether a file's name marks it as one that may hold secrets, such as `.env`, `.env.local`, a
 * private key or a credentials file. Such a file keeps no contents, whatever it holds (ADR 023).
 * A template meant to be shared, such as `.env.example`, keeps them.
 */
export const isSecretFile = (path: string): boolean => {
  const name = baseName(path).toLowerCase();
  if (SECRET_NAMES.has(name)) return true;
  if (name.startsWith(".env.")) return !/\.(?:example|sample|template|dist)$/.test(name);
  if (/^id_(?:rsa|dsa|ecdsa|ed25519)(?:_sk)?$/.test(name)) return true;
  return SECRET_EXTENSIONS.has(extensionOf(name));
};

/** Whether a file is an image the Workbench shows, by its name. */
export const isImageFile = (path: string): boolean => IMAGE_EXTENSIONS.has(extensionOf(baseName(path)));

/** A file as a scan found it. */
export interface ScannedFile {
  readonly kind: "file" | "link";
  readonly size: number;
  /** The SHA-256 of its contents, or of a link's target. */
  readonly hash: string;
}

/** A folder's files by their `/`-separated path inside it. */
export type FolderListing = ReadonlyMap<string, ScannedFile>;

/** A difference between two listings of one folder. */
export interface ListingChange {
  readonly path: string;
  readonly kind: FileChangeKind;
  readonly movedFrom: string | null;
  readonly before: ScannedFile | null;
  readonly after: ScannedFile | null;
}

const changeKind = (before: ScannedFile | null, after: ScannedFile | null): FileChangeKind => {
  if (before?.kind === "link" || after?.kind === "link") return "link";
  if (before === null) return "added";
  return after === null ? "deleted" : "edited";
};

/**
 * What changed from `before` to `after`, by path. A file that left one path and appeared at another
 * with the same contents is one move, not a deletion and an addition; each removed file pairs with
 * at most one added one, in path order.
 */
export const compareListings = (before: FolderListing, after: FolderListing): ReadonlyArray<ListingChange> => {
  const changes: Array<ListingChange> = [];
  for (const [path, was] of before) {
    const now = after.get(path) ?? null;
    if (now === null || now.hash !== was.hash || now.kind !== was.kind) {
      changes.push({ path, kind: changeKind(was, now), movedFrom: null, before: was, after: now });
    }
  }
  for (const [path, now] of after) {
    if (!before.has(path))
      changes.push({ path, kind: changeKind(null, now), movedFrom: null, before: null, after: now });
  }
  changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const removed = changes.filter((change) => change.kind === "deleted");
  const moved = new Set<ListingChange>();
  const result: Array<ListingChange> = [];
  for (const change of changes) {
    if (moved.has(change)) continue;
    if (change.kind !== "added") {
      result.push(change);
      continue;
    }
    const from = removed.find((each) => !moved.has(each) && each.before?.hash === change.after?.hash);
    if (from === undefined) {
      result.push(change);
      continue;
    }
    moved.add(from);
    result.push({ ...change, kind: "moved", movedFrom: from.path, before: from.before });
  }
  return result.filter((change) => !moved.has(change));
};

/** Whether two folders overlap: the same folder, or one inside the other. */
export const foldersOverlap = (a: string, b: string): boolean => {
  const inside = (inner: string, outer: string) =>
    inner.startsWith(outer) && (outer.endsWith("/") || inner[outer.length] === "/" || inner[outer.length] === "\\");
  return a === b || inside(a, b) || inside(b, a);
};

/**
 * What a change keeps of one version of a file, before it is read: a link keeps nothing but its
 * hash; a secret file and a file past the size kept for its kind keep their hash, size and kind;
 * any other file is read, up to `readUpTo` bytes, and kept if it is text or an image.
 */
export interface KeepPlan {
  readonly kind: FileKind;
  /** How much to read to keep it; null when it is not read at all. */
  readonly readUpTo: number | null;
  readonly notKept: NotKept | null;
}

export const keepPlan = (path: string, file: ScannedFile, limits: ActivityLimits): KeepPlan => {
  if (file.kind === "link") return { kind: "link", readUpTo: null, notKept: null };
  const image = isImageFile(path);
  const kind: FileKind = image ? "image" : "text";
  if (isSecretFile(path)) return { kind, readUpTo: null, notKept: "secret" };
  const limit = image ? limits.imageBytes : limits.textBytes;
  if (file.size > limit) return { kind: image ? "image" : "other", readUpTo: null, notKept: "too-large" };
  return { kind, readUpTo: limit, notKept: null };
};
