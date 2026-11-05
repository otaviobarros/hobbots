import { Schema } from "effect";
import { AgentId } from "./ids.ts";
import {
  MemoryAuthor,
  MemoryPath,
  type MemoryPath as MemoryPathType,
  MemoryProjectIdentity,
  MemoryScope,
  MemoryVersion,
} from "./memory.ts";

/**
 * What the Memory page shows of memory (ADR 028): a scope as one string for an address, the kind a
 * page's folder names, and the changes Memory › What changed lists.
 */

/**
 * A scope as one string, for an address or a cache key: `everyone`, `hob:<hob id>` or
 * `project:<identity>`. An identity may hold `/` and `:`, so a project's key is everything after
 * its first colon.
 */
export const memoryScopeKey = (scope: MemoryScope): string => {
  switch (scope._tag) {
    case "Everyone":
      return "everyone";
    case "Hob":
      return `hob:${scope.agentId}`;
    case "Project":
      return `project:${scope.identity}`;
  }
};

/** The scope `key` names, or null when it names none. */
export const memoryScopeOfKey = (key: string): MemoryScope | null => {
  if (key === "everyone") return { _tag: "Everyone" };
  const colon = key.indexOf(":");
  const rest = key.slice(colon + 1);
  if (colon <= 0 || rest === "") return null;
  switch (key.slice(0, colon)) {
    case "hob":
      return { _tag: "Hob", agentId: AgentId.make(rest) };
    case "project":
      return { _tag: "Project", identity: MemoryProjectIdentity.make(rest) };
    default:
      return null;
  }
};

/** Whether two scopes are the same one. */
export const sameMemoryScope = (a: MemoryScope, b: MemoryScope): boolean => memoryScopeKey(a) === memoryScopeKey(b);

/** A scope's key as a Schema, so an address or a query decodes to a scope or fails. */
export const MemoryScopeKey = Schema.String.check(
  Schema.makeFilter((key: string) => (memoryScopeOfKey(key) === null ? "Not a memory scope." : undefined)),
);

/**
 * What a page is, by the folder it is kept in: a rule a hob always follows, steps it learned, a
 * mistake not to repeat, a decision and why, a plain fact, the note of a chat (`sessions/`, which
 * ai-memory writes, ADR 028), or a page in no folder these name.
 */
export const MemoryKind = Schema.Literals(["rule", "howto", "gotcha", "decision", "fact", "chat", "note"]);
export type MemoryKind = typeof MemoryKind.Type;

// A Map, so a folder named like an object's own property (`constructor`, `__proto__`) is no kind.
const KIND_FOLDERS: ReadonlyMap<string, MemoryKind> = new Map([
  ["rules", "rule"],
  ["howtos", "howto"],
  ["gotchas", "gotcha"],
  ["decisions", "decision"],
  ["facts", "fact"],
  ["sessions", "chat"],
]);

/** The kind of the page at `path`, from its first folder. */
export const memoryKindOf = (path: MemoryPathType): MemoryKind => {
  const slash = path.indexOf("/");
  return (slash === -1 ? undefined : KIND_FOLDERS.get(path.slice(0, slash))) ?? "note";
};

/** The folder a page of `kind` is kept in; a note, which no folder names, goes in `notes/`. */
export const memoryFolderOf = (kind: MemoryKind): string =>
  [...KIND_FOLDERS].find(([, each]) => each === kind)?.[0] ?? "notes";

/** The most characters of a title a new page's file name keeps. */
const SLUG_MAX = 60;

/**
 * The path of a new page of `kind` titled `title`, in its kind's folder: `rules/use-pnpm-not-npm.md`.
 * The file name keeps the title's letters and digits, without accents, lower case, joined by `-`.
 */
export const memoryPathFor = (kind: MemoryKind, title: string): MemoryPathType => {
  const slug = title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, SLUG_MAX)
    .replace(/^-+|-+$/g, "");
  return MemoryPath.make(`${memoryFolderOf(kind)}/${slug || "page"}.md`);
};

/** The kinds in the order the Memory page groups them. */
export const MEMORY_KINDS: ReadonlyArray<MemoryKind> = MemoryKind.literals;

/** One saved version of a page, as Memory › What changed lists it. */
export const MemoryChange = Schema.Struct({
  scope: MemoryScope,
  path: MemoryPath,
  title: Schema.String,
  version: MemoryVersion,
  /** Who wrote it, or null when the engine has no record of it. */
  author: Schema.NullOr(MemoryAuthor),
  /** When it was written, ISO 8601. */
  at: Schema.String,
});
export type MemoryChange = typeof MemoryChange.Type;

/** A page by where it is kept and its path. */
export const MemoryPageRef = Schema.Struct({ scope: MemoryScope, path: MemoryPath });
export type MemoryPageRef = typeof MemoryPageRef.Type;

/**
 * Pages memory saved since the hub last asked. ai-memory sends no events of its own, so the hub asks
 * about once a minute and streams what it finds (ADR 028). A delete through the hub streams at once
 * as `deleted`, since a look only finds pages that are there.
 */
export const MemoryChanged = Schema.TaggedStruct("MemoryChanged", {
  changes: Schema.Array(MemoryChange),
  deleted: Schema.optionalKey(Schema.Array(MemoryPageRef)),
});
export type MemoryChanged = typeof MemoryChanged.Type;
