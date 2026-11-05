import { Schema } from "effect";
import { AgentId } from "./ids.ts";

/**
 * Memory in Hobbots' own words (ADR 028). The engine behind it, ai-memory today, never shows in
 * these types: no workspaces, projects, keys or routes.
 */

/**
 * Who a project is across clones: its normalized Git `origin` remote, or the folder's name when it
 * has no remote.
 */
export const MemoryProjectIdentity = Schema.String.check(Schema.isNonEmpty()).pipe(
  Schema.brand("MemoryProjectIdentity"),
);
export type MemoryProjectIdentity = typeof MemoryProjectIdentity.Type;

/** Whose memory a page is in: one hob's own, a project's, or everyone's. A thread is not a scope. */
export const MemoryScope = Schema.Union([
  Schema.TaggedStruct("Hob", { agentId: AgentId }),
  Schema.TaggedStruct("Project", { identity: MemoryProjectIdentity }),
  Schema.TaggedStruct("Everyone", {}),
]);
export type MemoryScope = typeof MemoryScope.Type;

/** Who wrote a version of a page: a hob, or you. */
export const MemoryAuthor = Schema.Union([
  Schema.TaggedStruct("Hob", { agentId: AgentId }),
  Schema.TaggedStruct("You", {}),
]);
export type MemoryAuthor = typeof MemoryAuthor.Type;

/**
 * Who a memory call is made for, and so what it may reach. The hub builds it from what it knows, never
 * from a tool's input: a hob's id and the project identities of the folders it works in.
 */
export type MemoryActor =
  | {
      readonly _tag: "Hob";
      readonly agentId: AgentId;
      readonly projects: ReadonlyArray<MemoryProjectIdentity>;
    }
  | { readonly _tag: "You" };

/** The author a call's actor writes as. */
export const memoryAuthorOf = (actor: MemoryActor): MemoryAuthor =>
  actor._tag === "You" ? { _tag: "You" } : { _tag: "Hob", agentId: actor.agentId };

/**
 * A page's place inside its scope: a relative markdown path such as `notes/tests.md`, of lower-case
 * letters, digits, `-`, `_` and `.`, in folders, with no empty, `.` or `..` part.
 */
export const MemoryPath = Schema.String.check(
  Schema.isPattern(/^(?:[a-z0-9_][a-z0-9._-]*\/)*[a-z0-9_][a-z0-9._-]*\.md$/, {
    message: "A memory path is a relative .md path of lower-case letters, digits, '-', '_' and '.'.",
  }),
  Schema.isMaxLength(200),
).pipe(Schema.brand("MemoryPath"));
export type MemoryPath = typeof MemoryPath.Type;

/** One version of a page, opaque. Every write makes a new one. */
export const MemoryVersion = Schema.String.pipe(Schema.brand("MemoryVersion"));
export type MemoryVersion = typeof MemoryVersion.Type;

/** A page as it is now. */
export const MemoryPage = Schema.Struct({
  scope: MemoryScope,
  path: MemoryPath,
  markdown: Schema.String,
  tags: Schema.Array(Schema.String),
  pinned: Schema.Boolean,
  version: MemoryVersion,
  /** Who wrote this version, or null when the engine has no record of it. */
  author: Schema.NullOr(MemoryAuthor),
  updatedAt: Schema.String,
});
export type MemoryPage = typeof MemoryPage.Type;

/** A page in a list, without its markdown. */
export const MemoryPageSummary = Schema.Struct({
  scope: MemoryScope,
  path: MemoryPath,
  title: Schema.String,
  pinned: Schema.Boolean,
  updatedAt: Schema.String,
});
export type MemoryPageSummary = typeof MemoryPageSummary.Type;

/** A page that matched a search, with the words around the match. */
export const MemoryHit = Schema.Struct({
  scope: MemoryScope,
  path: MemoryPath,
  title: Schema.String,
  snippet: Schema.String,
});
export type MemoryHit = typeof MemoryHit.Type;

/** One version in a page's history, newest first. */
export const MemoryPageVersion = Schema.Struct({
  version: MemoryVersion,
  author: Schema.NullOr(MemoryAuthor),
  writtenAt: Schema.String,
  latest: Schema.Boolean,
});
export type MemoryPageVersion = typeof MemoryPageVersion.Type;

/** A line of what a version changed: added, removed, or kept around a change. */
export const MemoryChangedLine = Schema.Struct({
  op: Schema.Literals(["add", "remove", "same"]),
  text: Schema.String,
});
export type MemoryChangedLine = typeof MemoryChangedLine.Type;

/**
 * What one version of a page changed against the version it replaced: the first version adds all
 * of itself. `cut` says the lines stop short of the whole change, as when it was too large.
 */
export const MemoryVersionChanges = Schema.Struct({
  first: Schema.Boolean,
  lines: Schema.Array(MemoryChangedLine),
  cut: Schema.Boolean,
});
export type MemoryVersionChanges = typeof MemoryVersionChanges.Type;

/** What a write or a forget expects to find, so a change made meanwhile is never overwritten unseen. */
export type MemoryExpected =
  /** Whatever is there. */
  | { readonly _tag: "Any" }
  /** No page at that path yet. */
  | { readonly _tag: "New" }
  /** This version is still the latest. */
  | { readonly _tag: "Version"; readonly version: MemoryVersion };

/** A page to write. Its title is its first `# ` heading. */
export interface MemoryDraft {
  readonly path: MemoryPath;
  readonly markdown: string;
  readonly tags: ReadonlyArray<string>;
  readonly pinned: boolean;
}

/** A page's title: its first `# ` heading, or its file name without `.md`. */
export const memoryTitleOf = (path: MemoryPath, markdown: string): string => {
  const heading = markdown
    .split("\n")
    .find((line) => line.startsWith("# "))
    ?.slice(2)
    .trim();
  return heading || (path.split("/").at(-1) ?? path).replace(/\.md$/, "");
};

/** The memory engine did not answer. Callers treat it as an outage, never as an empty memory. */
export class MemoryUnavailable extends Schema.TaggedError<MemoryUnavailable>()("MemoryUnavailable", {
  message: Schema.String,
}) {}

/** A write or a forget lost to a newer version, or found no page where it expected one. */
export class MemoryConflict extends Schema.TaggedError<MemoryConflict>()("MemoryConflict", {
  path: MemoryPath,
  /** The latest version now, or null when there is no page. */
  current: Schema.NullOr(MemoryVersion),
}) {}

/**
 * Whether `actor` may touch `scope`. You may touch every scope. A hob may touch its own memory, the
 * projects it works in and everyone's, never another hob's or a project it does not work in. Whether
 * a share needs your review is decided by the caller before it gets here.
 */
export const memoryScopeAllowed = (actor: MemoryActor, scope: MemoryScope): boolean => {
  if (actor._tag === "You") return true;
  switch (scope._tag) {
    case "Hob":
      return scope.agentId === actor.agentId;
    case "Project":
      return actor.projects.includes(scope.identity);
    case "Everyone":
      return true;
  }
};

/**
 * A project's identity from its folder's Git `origin` remote and the folder's name, so two clones of
 * one repository share it: the host and path, lower case, without scheme, user, port or `.git`.
 * `git@github.com:Me/App.git`, `https://github.com/me/app` and `ssh://git@github.com:22/me/app.git`
 * all give `github.com/me/app`. A folder with no remote uses its own name.
 */
export const memoryProjectIdentity = (origin: string | null, folderName: string): MemoryProjectIdentity => {
  const remote = origin === null ? null : remoteIdentity(origin);
  return MemoryProjectIdentity.make(remote ?? (folderName.trim().toLowerCase() || "folder"));
};

const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/** `text` without `char` at its start and end. Plain loops, so a long run of it costs no more than reading it. */
const trimChar = (text: string, char: string) => {
  let start = 0;
  let end = text.length;
  while (start < end && text[start] === char) start++;
  while (end > start && text[end - 1] === char) end--;
  return text.slice(start, end);
};

/** The host of `user@host:port`, without user or port; an IPv6 host keeps its brackets and colons. */
const hostOf = (authority: string): string => {
  const hostAndPort = authority.slice(authority.lastIndexOf("@") + 1);
  if (!hostAndPort.startsWith("[")) return hostAndPort.split(":")[0] as string;
  const close = hostAndPort.indexOf("]");
  return close === -1 ? "" : hostAndPort.slice(0, close + 1);
};

// Split with indexOf rather than one regular expression, so no remote, however long, backtracks.
const remoteIdentity = (origin: string): string | null => {
  const trimmed = origin.trim();
  const scheme = SCHEME.exec(trimmed);
  let authority: string;
  let rest: string;
  if (scheme) {
    const after = trimmed.slice(scheme[0].length);
    const slash = after.indexOf("/");
    if (slash === -1) return null;
    authority = after.slice(0, slash);
    rest = after.slice(slash + 1);
  } else {
    // `user@host:path`, Git's scp-like form, has no slash before its colon. An IPv6 host is bracketed.
    const close = /^(?:[^/@[]*@)?\[/.test(trimmed) ? trimmed.indexOf("]") : -1;
    const colon = trimmed.indexOf(":", close + 1);
    const slash = trimmed.indexOf("/");
    if (colon <= 0 || (slash !== -1 && slash < colon)) return null;
    authority = trimmed.slice(0, colon);
    rest = trimmed.slice(colon + 1);
  }
  const host = hostOf(authority);
  const end = [rest.indexOf("?"), rest.indexOf("#")].filter((at) => at !== -1);
  let path = trimChar(end.length === 0 ? rest : rest.slice(0, Math.min(...end)), "/");
  if (path.toLowerCase().endsWith(".git")) path = trimChar(path.slice(0, -4), "/");
  if (host === "" || path === "") return null;
  return `${host.toLowerCase()}/${path.toLowerCase()}`;
};

/**
 * One thing that happened in a thread, as capture sends it to memory (ADR 028, Capture and
 * summaries): its start, a message of yours, a reply, a tool step, or a Quest it took part in.
 * Memory keeps a thread's items as one session in the hob's own memory, whichever brain wrote them.
 */
export interface MemoryCaptureItem {
  /**
   * What the item stands for, the same every time it is sent, such as the journal entry it came from.
   * Memory skips an item whose key it has seen, for 30 days.
   */
  readonly key: string;
  readonly kind: "start" | "message" | "reply" | "tool" | "quest";
  /** Already redacted. */
  readonly text: string;
}

/**
 * Something Check now found (ADR 028): pages that disagree, or a page that looks out of date. It
 * waits only in Memory › To review, never in the Inbox.
 */
export const MemoryFinding = Schema.Struct({
  kind: Schema.Literals(["disagree", "stale"]),
  scope: MemoryScope,
  /** The pages it is about, in the scope, the first one first. */
  paths: Schema.Array(MemoryPath),
  /** What the engine said about them, as it said it. */
  message: Schema.String,
});
export type MemoryFinding = typeof MemoryFinding.Type;
