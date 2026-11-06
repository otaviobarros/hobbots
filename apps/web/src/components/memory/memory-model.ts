import type { MemoryScopes } from "@hobbots/api";
import {
  type Agent,
  type AgentId,
  MEMORY_KINDS,
  type MemoryChange,
  type MemoryChangedLine,
  type MemoryKind,
  type MemoryPageSummary,
  type MemoryPageVersion,
  type MemoryPath,
  type MemoryScope,
  type MemoryVersion,
  memoryKindOf,
  memoryScopeKey,
  memoryScopeOfKey,
  memorySearchTerms,
  memorySnippetOf,
  type SnippetPart,
  sameMemoryScope,
} from "@hobbots/domain";
import { Schema } from "effect";
import { messages } from "./messages.ts";

const copy = messages;

/** Which What changed rows show: everything, the hobs' saves, or your own changes. */
export const ChangeFilter = Schema.Literals(["all", "hobs", "you"]);
export type ChangeFilter = typeof ChangeFilter.Type;

/** What the Memory page's address holds (STD-REACT-002). */
export interface MemorySearch {
  /** `changes` opens What changed, and `review` To review. */
  readonly view?: "changes" | "review" | undefined;
  /** In To review, what is open: a share by its id, or `check:<n>` for Check now's nth finding. */
  readonly item?: string | undefined;
  /** The scope open, by its key. */
  readonly scope?: string | undefined;
  /** The page open in that scope. */
  readonly page?: string | undefined;
  /** The version of the page whose changes show. */
  readonly v?: string | undefined;
  /** The kind a scope's list shows. */
  readonly kind?: MemoryKind | undefined;
  /** What to search for. */
  readonly q?: string | undefined;
  /** The scope a search looks in, by its key; everywhere without it. */
  readonly in?: string | undefined;
  readonly show?: ChangeFilter | undefined;
  /** `page` opens the open page in the editor; `new`, with a scope, a new page there. */
  readonly edit?: "page" | "new" | undefined;
}

/** The view the Memory page shows. */
export type MemoryView =
  | { readonly _tag: "Overview" }
  | { readonly _tag: "Changes"; readonly show: ChangeFilter }
  | { readonly _tag: "Review"; readonly item: string | null }
  | { readonly _tag: "Scope"; readonly scope: MemoryScope; readonly kind: MemoryKind | null }
  | {
      readonly _tag: "Page";
      readonly scope: MemoryScope;
      readonly path: MemoryPath;
      readonly version: MemoryVersion | null;
    }
  | { readonly _tag: "Search"; readonly q: string; readonly within: MemoryScope | null }
  | { readonly _tag: "Edit"; readonly scope: MemoryScope; readonly path: MemoryPath }
  | { readonly _tag: "New"; readonly scope: MemoryScope; readonly kind: MemoryKind | null };

const PATH = /^(?:[a-z0-9_][a-z0-9._-]*\/)*[a-z0-9_][a-z0-9._-]*\.md$/;

/** The view a scope's address names: a page, its editor, a new page, or the scope's list. */
const scopeViewOf = (scope: MemoryScope, search: MemorySearch): MemoryView => {
  if (search.page !== undefined && PATH.test(search.page)) {
    const path = search.page as MemoryPath;
    if (search.edit === "page") return { _tag: "Edit", scope, path };
    return { _tag: "Page", scope, path, version: (search.v as MemoryVersion | undefined) ?? null };
  }
  if (search.edit === "new") return { _tag: "New", scope, kind: search.kind ?? null };
  return { _tag: "Scope", scope, kind: search.kind ?? null };
};

/** The view an address names. A search wins, then a page, then a scope; anything unreadable opens the overview. */
export const memoryViewOf = (search: MemorySearch): MemoryView => {
  const q = search.q?.trim() ?? "";
  if (q !== "") return { _tag: "Search", q, within: search.in === undefined ? null : memoryScopeOfKey(search.in) };
  if (search.view === "changes") return { _tag: "Changes", show: search.show ?? "all" };
  if (search.view === "review") return { _tag: "Review", item: search.item ?? null };
  const scope = search.scope === undefined ? null : memoryScopeOfKey(search.scope);
  return scope === null ? { _tag: "Overview" } : scopeViewOf(scope, search);
};

/** The address of a view, the inverse of `memoryViewOf`. */
export const memorySearchOf = (view: MemoryView): MemorySearch => {
  switch (view._tag) {
    case "Overview":
      return {};
    case "Changes":
      return { view: "changes", show: view.show === "all" ? undefined : view.show };
    case "Review":
      return { view: "review", item: view.item ?? undefined };
    case "Scope":
      return { scope: memoryScopeKey(view.scope), kind: view.kind ?? undefined };
    case "Page":
      return { scope: memoryScopeKey(view.scope), page: view.path, v: view.version ?? undefined };
    case "Search":
      return { q: view.q, in: view.within === null ? undefined : memoryScopeKey(view.within) };
    case "Edit":
      return { scope: memoryScopeKey(view.scope), page: view.path, edit: "page" };
    case "New":
      return { scope: memoryScopeKey(view.scope), kind: view.kind ?? undefined, edit: "new" };
  }
};

/**
 * Which view a line said after a change belongs to: a page and its editor share one, so Save shows
 * its line on the page it returns to, and any other view drops it.
 */
export const flashKeyOf = (view: MemoryView): string => {
  switch (view._tag) {
    case "Page":
    case "Edit":
      return `page\n${memoryScopeKey(view.scope)}\n${view.path}`;
    case "Scope":
    case "New":
      return `scope\n${memoryScopeKey(view.scope)}`;
    default:
      return view._tag;
  }
};

/** The hobs the page names, by id: active ones and the retired ones a scope may still belong to. */
export type HobDirectory = ReadonlyMap<AgentId, Agent>;

/** A project's short name: the last part of its identity, as `site` for `github.com/me/site`. */
const projectName = (identity: string): string => identity.split("/").filter(Boolean).at(-1) ?? identity;

/** A scope's name as the page shows it. */
export const scopeName = (scope: MemoryScope, hobs: HobDirectory): string => {
  switch (scope._tag) {
    case "Everyone":
      return copy.nav.about;
    case "Hob":
      return hobs.get(scope.agentId)?.name ?? copy.nav.formerHob;
    case "Project":
      return projectName(scope.identity);
  }
};

/** Where a page lives, as a row's last line says it. */
export const scopeWhere = (scope: MemoryScope, hobs: HobDirectory): string => {
  switch (scope._tag) {
    case "Everyone":
      return copy.where.about;
    case "Hob":
      return copy.where.hob({ name: scopeName(scope, hobs) });
    case "Project":
      return copy.where.project({ name: scopeName(scope, hobs) });
  }
};

/** Where a page is kept, as its side says it: a hob's memory only, a project, or About you. */
export const keptInOf = (scope: MemoryScope, hobs: HobDirectory): string => {
  switch (scope._tag) {
    case "Hob":
      return copy.page.keptInHob({ name: scopeName(scope, hobs) });
    case "Project":
      return copy.page.keptInProject({ name: scopeName(scope, hobs) });
    case "Everyone":
      return copy.page.keptInAbout;
  }
};

/** Who wrote a version, by name. */
export const authorName = (author: MemoryChange["author"], hobs: HobDirectory): string => {
  if (author === null) return copy.page.someone;
  if (author._tag === "You") return copy.page.you;
  return hobs.get(author.agentId)?.name ?? copy.nav.formerHob;
};

/** One row of the scope list beside the page. */
export interface ScopeRow {
  readonly scope: MemoryScope;
  readonly key: string;
  readonly name: string;
  /** A project's identity, or a hob's role, under the name. */
  readonly sub: string;
  /** How many pages it holds; null while that is read. */
  readonly pages: number | null;
  readonly hob: Agent | undefined;
}

/** The scope list: About you, then every project, then every hob with or without pages. */
export interface ScopeNav {
  readonly about: ScopeRow;
  readonly projects: ReadonlyArray<ScopeRow>;
  readonly hobs: ReadonlyArray<ScopeRow>;
}

const EVERYONE: MemoryScope = { _tag: "Everyone" };

/**
 * The scope list from what memory holds and the hobs you have. A hob with no pages yet is listed
 * with none; a hob scope whose hob is not active is listed only while it holds pages.
 */
export const scopeNav = (
  overview: MemoryScopes | undefined,
  active: ReadonlyArray<Agent>,
  hobs: HobDirectory,
): ScopeNav => {
  const counted = overview?.scopes ?? [];
  const countOf = (scope: MemoryScope) =>
    overview === undefined ? null : (counted.find((entry) => sameMemoryScope(entry.scope, scope))?.pages ?? 0);
  const row = (scope: MemoryScope, sub: string): ScopeRow => ({
    scope,
    key: memoryScopeKey(scope),
    name: scopeName(scope, hobs),
    sub,
    pages: countOf(scope),
    hob: scope._tag === "Hob" ? hobs.get(scope.agentId) : undefined,
  });
  const projects = counted
    .flatMap((entry) => (entry.scope._tag === "Project" ? [entry.scope] : []))
    .sort((a, b) => projectName(a.identity).localeCompare(projectName(b.identity)))
    .map((scope) => row(scope, scope.identity === projectName(scope.identity) ? "" : scope.identity));
  const activeIds = new Set(active.map((hob) => hob.id));
  const former = counted.flatMap((entry) =>
    entry.scope._tag === "Hob" && !activeIds.has(entry.scope.agentId) ? [entry.scope] : [],
  );
  const hobRows = [
    ...active.map((hob) => row({ _tag: "Hob", agentId: hob.id }, hob.roleTitle)),
    ...former.map((scope) => row(scope, "")),
  ];
  return { about: row(EVERYONE, copy.nav.aboutHint), projects, hobs: hobRows };
};

/** How many pages memory holds in all, and in how many shared places (About you and the projects). */
export const memoryTotals = (overview: MemoryScopes) => ({
  pages: overview.scopes.reduce((sum, entry) => sum + entry.pages, 0),
  shared: overview.scopes.filter((entry) => entry.scope._tag !== "Hob").length,
});

/** The line under the title. */
export const headLine = (
  hobs: number,
  overview: MemoryScopes | undefined,
  state: { readonly offline: boolean },
): string => {
  if (state.offline) return copy.head.offline;
  if (overview === undefined) return copy.head.loading({ hobs });
  const totals = memoryTotals(overview);
  return totals.pages === 0
    ? copy.head.empty({ hobs })
    : copy.head.full({ hobs, count: totals.pages, shared: totals.shared });
};

/** Pages of one kind, in the order the page groups them. */
export interface KindGroup {
  readonly kind: MemoryKind;
  readonly pages: ReadonlyArray<MemoryPageSummary>;
}

/** A scope's pages by kind, each group in the list's own order, empty kinds left out. */
export const kindGroups = (pages: ReadonlyArray<MemoryPageSummary>): ReadonlyArray<KindGroup> =>
  MEMORY_KINDS.map((kind) => ({ kind, pages: pages.filter((page) => memoryKindOf(page.path) === kind) })).filter(
    (group) => group.pages.length > 0,
  );

/** The kind chips over a scope's list: All, then each kind it holds, with their counts. */
export const kindChips = (pages: ReadonlyArray<MemoryPageSummary>) => [
  { kind: "all" as const, label: copy.all, count: pages.length },
  ...kindGroups(pages).map((group) => ({
    kind: group.kind,
    label: copy.kinds[group.kind].group,
    count: group.pages.length,
  })),
];

const WEEK_MS = 7 * 24 * 60 * 60_000;

/** What hobs saved in the last 7 days, newest first, at most `limit`: the overview's Recently learned. */
export const recentlyLearned = (changes: ReadonlyArray<MemoryChange>, now: Date, limit = 5) =>
  changes
    .filter((change) => change.author?._tag === "Hob" && now.getTime() - new Date(change.at).getTime() <= WEEK_MS)
    .slice(0, limit);

/** The rows What changed shows under a filter. */
export const filterChanges = (changes: ReadonlyArray<MemoryChange>, show: ChangeFilter) =>
  show === "all" ? changes : changes.filter((change) => change.author?._tag === (show === "hobs" ? "Hob" : "You"));

/** The local day an instant falls on, as `YYYY-MM-DD`, so changes group by the reader's days. */
const localDay = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

/** Changes by the local day they were saved on, newest day first, each day newest first. */
export const changesByDay = (changes: ReadonlyArray<MemoryChange>, now: Date) => {
  const today = localDay(now);
  const yesterday = localDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
  const days = new Map<string, Array<MemoryChange>>();
  for (const change of changes) {
    const day = localDay(new Date(change.at));
    days.set(day, [...(days.get(day) ?? []), change]);
  }
  return [...days.entries()]
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([day, rows]) => ({
      day,
      label: day === today ? copy.changes.today : day === yesterday ? copy.changes.yesterday : null,
      first: rows[0]?.at ?? "",
      rows: [...rows].sort((a, b) => b.at.localeCompare(a.at)),
    }));
};

/** A page's body without its `# ` title, which the page shows as its heading. */
export const pageBody = (markdown: string): string => markdown.replace(/^\s*#\s+[^\n]*\n?/, "").trim();

/** A page's title from its markdown, or its file name when it has no `# ` heading. */
export const pageTitle = (markdown: string, path: MemoryPath): string =>
  /^#\s+(.+)$/m.exec(markdown)?.[1]?.trim() ?? path.replace(/^.*\//, "").replace(/\.md$/, "");

/** One version in a page's History, with what it says it did. */
export interface HistoryRow {
  readonly version: MemoryVersion;
  readonly what: string;
  readonly at: string;
  readonly latest: boolean;
}

/** A page's History, newest first: who learned it, then who changed it each time after. */
export const historyRows = (history: ReadonlyArray<MemoryPageVersion>, hobs: HobDirectory): ReadonlyArray<HistoryRow> =>
  history.map((entry, at) => {
    const first = at === history.length - 1;
    const you = entry.author?._tag === "You";
    const who = authorName(entry.author, hobs);
    const what = first
      ? you
        ? copy.page.wroteThis
        : copy.page.learnedThis({ who })
      : you
        ? copy.page.youChanged
        : copy.page.changedThis({ who });
    return {
      version: entry.version,
      what,
      at: entry.writtenAt,
      latest: entry.latest,
    };
  });

/** A version's changed lines as the page shows them: blank lines left out, so paragraphs read as lines. */
export const shownLines = (lines: ReadonlyArray<MemoryChangedLine>): ReadonlyArray<MemoryChangedLine> =>
  lines.filter((line) => line.text.trim() !== "");

/** The parts of a search hit's snippet, the words that match the search marked. */
export const hitParts = (snippet: string, q: string): ReadonlyArray<SnippetPart> => {
  const terms = memorySearchTerms(q);
  return terms.length === 0
    ? [{ text: snippet, match: false }]
    : memorySnippetOf(snippet, terms, Math.max(snippet.length, 1));
};

/** The search's scope chips: Everywhere, About you, then each project and each hob that holds pages. */
export const searchScopes = (nav: ScopeNav) => [
  { key: "all", scope: null, label: copy.results.everywhere },
  ...[nav.about, ...nav.projects, ...nav.hobs]
    .filter((row) => row.pages !== null && row.pages > 0)
    .map((row) => ({ key: row.key, scope: row.scope, label: row.name })),
];
