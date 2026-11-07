import type { SkillsList } from "@hobbots/api";
import {
  type Agent,
  type AgentId,
  effectiveDecision,
  hobAnswers,
  memoryScopeKey,
  memoryScopeOfKey,
  type SafetyPreset,
  SKILL_DESCRIPTION_MAX,
  type Skill,
  type SkillAssignment,
  type SkillId,
  type SkillOrigin,
  type SkillRevision,
  type SkillRevisionHash,
  type SkillScope,
  type SkillSource,
} from "@hobbots/domain";
import { Schema } from "effect";
import { messages } from "./messages.ts";

const copy = messages;

/**
 * The hobs Draft it with a hob offers: those whose permissions let them suggest a skill under the
 * preset. Ask still lets one, since you answer it in the chat; Never does not.
 */
export const draftingHobs = (active: ReadonlyArray<Agent>, preset: SafetyPreset): ReadonlyArray<Agent> =>
  active.filter((hob) => effectiveDecision(preset, hobAnswers(hob.policy), "propose-skill") !== "deny");

/** Where Add a skill takes it from. */
export const ImportFrom = Schema.Literals(["git", "file", "write"]);
export type ImportFrom = typeof ImportFrom.Type;

/** A skill's tabs. Instructions is the default and has no value in the address. */
export const SkillTab = Schema.Literals(["who", "history", "activity"]);
export type SkillTab = typeof SkillTab.Type;

/** What the Skills page's address holds (STD-REACT-002). */
export interface SkillsSearch {
  /** A scope's skills, by its key. */
  readonly scope?: string | undefined;
  /** The skill open, by its id. */
  readonly skill?: string | undefined;
  readonly tab?: SkillTab | undefined;
  /** In Instructions, the file open. */
  readonly file?: string | undefined;
  /** In History, the revision whose changes show. */
  readonly diff?: string | undefined;
  /** `skill` opens the open skill in the editor; `new` the editor for a new skill. */
  readonly edit?: "skill" | "new" | undefined;
  /** Add a skill, from where. */
  readonly add?: ImportFrom | undefined;
  /** `skills` opens Export skills. */
  readonly export?: "skills" | undefined;
  readonly q?: string | undefined;
  /** `changes` opens What changed; `review` To review, with `item` the proposal open there. */
  readonly view?: "changes" | "review" | undefined;
  readonly item?: string | undefined;
}

export type SkillsView =
  | { readonly _tag: "Overview" }
  | { readonly _tag: "Changes" }
  | { readonly _tag: "Review"; readonly item: string | null }
  | { readonly _tag: "Scope"; readonly scope: SkillScope }
  | { readonly _tag: "Add"; readonly from: ImportFrom }
  | { readonly _tag: "Export" }
  | { readonly _tag: "New" }
  | {
      readonly _tag: "Skill";
      readonly skillId: SkillId;
      readonly tab: SkillTab | null;
      readonly file: string | null;
      readonly diff: SkillRevisionHash | null;
    }
  | { readonly _tag: "Edit"; readonly skillId: SkillId }
  | { readonly _tag: "Search"; readonly q: string };

/** The open skill's view: its editor, or the skill on a tab. */
const skillViewOf = (search: SkillsSearch, skillId: SkillId): SkillsView =>
  search.edit === "skill"
    ? { _tag: "Edit", skillId }
    : {
        _tag: "Skill",
        skillId,
        tab: search.tab ?? null,
        file: search.file ?? null,
        diff: (search.diff as SkillRevisionHash | undefined) ?? null,
      };

/** The view an address names. A search wins, then the editor, a skill, Add, What changed, To review and a scope; anything else opens the overview. */
export const skillsViewOf = (search: SkillsSearch): SkillsView => {
  const q = search.q?.trim() ?? "";
  if (q !== "") return { _tag: "Search", q };
  if (search.edit === "new") return { _tag: "New" };
  if (search.skill !== undefined && search.skill !== "") return skillViewOf(search, search.skill as SkillId);
  if (search.add !== undefined) return { _tag: "Add", from: search.add };
  if (search.export === "skills") return { _tag: "Export" };
  if (search.view === "changes") return { _tag: "Changes" };
  if (search.view === "review") return { _tag: "Review", item: search.item ?? null };
  const scope = search.scope === undefined ? null : memoryScopeOfKey(search.scope);
  return scope === null ? { _tag: "Overview" } : { _tag: "Scope", scope };
};

/** The address of a view, the inverse of `skillsViewOf`. */
export const skillsSearchOf = (view: SkillsView): SkillsSearch => {
  switch (view._tag) {
    case "Overview":
      return {};
    case "Changes":
      return { view: "changes" };
    case "Review":
      return { view: "review", item: view.item ?? undefined };
    case "Scope":
      return { scope: memoryScopeKey(view.scope) };
    case "Add":
      return { add: view.from };
    case "Export":
      return { export: "skills" };
    case "New":
      return { edit: "new" };
    case "Skill":
      return {
        skill: view.skillId,
        tab: view.tab ?? undefined,
        file: view.file ?? undefined,
        diff: view.diff ?? undefined,
      };
    case "Edit":
      return { skill: view.skillId, edit: "skill" };
    case "Search":
      return { q: view.q };
  }
};

/** A skill's view on a tab. */
export const skillView = (skillId: SkillId, tab: SkillTab | null = null): SkillsView => ({
  _tag: "Skill",
  skillId,
  tab,
  file: null,
  diff: null,
});

/** A skill's name as a title: `release-steps` reads "Release steps". */
export const skillTitle = (name: string): string => {
  const words = name.replaceAll("-", " ");
  return words.charAt(0).toLocaleUpperCase() + words.slice(1);
};

export type HobDirectory = ReadonlyMap<AgentId, Agent>;

/** A project's short name: the last part of its identity, as `site` for `github.com/me/site`. */
export const projectName = (identity: string): string => identity.split("/").filter(Boolean).at(-1) ?? identity;

/** A scope's name, as a group or a row says it. */
export const scopeName = (scope: SkillScope, hobs: HobDirectory): string => {
  switch (scope._tag) {
    case "Everyone":
      return copy.scopes.everyone;
    case "Project":
      return copy.scopes.project({ name: projectName(scope.identity) });
    case "Hob":
      return hobs.get(scope.agentId)?.name ?? copy.scopes.formerHob;
  }
};

/** The origin a skill's revisions come from, or null for one written in Hobbots. */
export const originOf = (sourceId: Skill["sourceId"], sources: ReadonlyArray<SkillSource>): SkillOrigin | null =>
  sourceId === null ? null : (sources.find((source) => source.id === sourceId)?.origin ?? null);

/**
 * A skill from `~/.agents/skills` (ADR 029): read-only in Hobbots, and out of backups and exports.
 * Its folder there, as `~/.agents/skills/pdf-forms`, or null for any other skill.
 */
export const agentsFolderOf = (
  skill: Pick<Skill, "sourceId" | "name">,
  sources: ReadonlyArray<SkillSource>,
  revisions: ReadonlyArray<Pick<SkillRevision, "path">> = [],
): string | null => {
  const origin = originOf(skill.sourceId, sources);
  if (origin?._tag !== "AgentsFolder") return null;
  return `${copy.source.agents}/${revisions[0]?.path ?? skill.name}`;
};

/** A Git address without its scheme and `.git`, as `github.com/acme/skills`. */
const shortGit = (url: string) =>
  url
    .replace(/^[a-z+]+:\/\//, "")
    .replace(/^git@([^:]+):/, "$1/")
    .replace(/\.git$/, "");

/** Where a skill comes from, in a few words. */
export const originText = (origin: SkillOrigin | null): string => {
  if (origin === null) return copy.source.written;
  switch (origin._tag) {
    case "Written":
      return copy.source.written;
    case "Folder":
      return origin.path;
    case "Archive":
      return origin.fileName;
    case "Git":
      return origin.ref === null ? shortGit(origin.url) : `${shortGit(origin.url)} · ${origin.ref}`;
    case "AgentsFolder":
      return copy.source.agents;
  }
};

/** One skill as a scope's list shows it: pinned to the assignment's revision there, or its newest one. */
export interface SkillRow {
  readonly skill: Skill;
  readonly assignment: SkillAssignment | null;
  /** The revision number the row shows, or null when its pin is an older revision than the newest. */
  readonly number: number | null;
  readonly origin: SkillOrigin | null;
}

/** A scope and its skills, or the skills no scope has yet when `scope` is null. */
export interface SkillGroup {
  readonly key: string;
  readonly scope: SkillScope | null;
  readonly rows: ReadonlyArray<SkillRow>;
}

const scopeOrder = (scope: SkillScope) => (scope._tag === "Everyone" ? 0 : scope._tag === "Project" ? 1 : 2);

/**
 * The library by scope, as the overview lists it: Everyone, each project and each hob, then the skills
 * no one has yet. A skill given to two scopes shows in each, pinned to its revision there.
 */
export const libraryGroups = (list: SkillsList, hobs: HobDirectory): ReadonlyArray<SkillGroup> => {
  const skills = new Map(list.skills.map((skill) => [skill.id, skill]));
  const numberOf = (skill: Skill, pin: SkillRevisionHash) => (pin === skill.latest ? skill.revisions : null);
  const groups = new Map<string, { scope: SkillScope; rows: Array<SkillRow> }>();
  for (const assignment of list.assignments) {
    const skill = skills.get(assignment.skillId);
    if (skill === undefined) continue;
    const key = memoryScopeKey(assignment.scope);
    const group = groups.get(key) ?? { scope: assignment.scope, rows: [] };
    group.rows.push({
      skill,
      assignment,
      number: numberOf(skill, assignment.pin),
      origin: originOf(skill.sourceId, list.sources),
    });
    groups.set(key, group);
  }
  const sorted = [...groups.entries()]
    .map(([key, group]) => ({ key, scope: group.scope, rows: sortRows(group.rows) }))
    .sort(
      (a, b) =>
        scopeOrder(a.scope) - scopeOrder(b.scope) || scopeName(a.scope, hobs).localeCompare(scopeName(b.scope, hobs)),
    );
  const given = new Set(list.assignments.map((assignment) => assignment.skillId));
  const loose = list.skills
    .filter((skill) => !given.has(skill.id))
    .map((skill) => ({
      skill,
      assignment: null,
      number: skill.revisions,
      origin: originOf(skill.sourceId, list.sources),
    }));
  return loose.length === 0 ? sorted : [...sorted, { key: "none", scope: null, rows: sortRows(loose) }];
};

/** One skill as Export skills lists it: its newest revision, and where it applies first. */
export interface ExportRow {
  readonly skill: Skill;
  readonly scope: SkillScope | null;
  /** The scope's name, with how many more scopes it has. */
  readonly where: string;
}

/**
 * Every skill once, as Export skills lists it: in the overview's order, Everyone, each project and
 * each hob, then those no one has, each under the first scope it has. Skills from `~/.agents/skills`
 * are listed apart, as not exported: they stay in that folder (ADR 029).
 */
export const exportRows = (
  list: SkillsList,
  hobs: HobDirectory,
): { readonly rows: ReadonlyArray<ExportRow>; readonly notExported: ReadonlyArray<Skill> } => {
  const groups = libraryGroups(list, hobs);
  const seen = new Set<SkillId>();
  const rows: Array<ExportRow> = [];
  const notExported: Array<Skill> = [];
  for (const group of groups) {
    for (const row of group.rows) {
      if (seen.has(row.skill.id)) continue;
      seen.add(row.skill.id);
      if (row.origin?._tag === "AgentsFolder") {
        notExported.push(row.skill);
        continue;
      }
      const more = groups.filter((other) => other !== group && other.rows.some((one) => one.skill.id === row.skill.id));
      const name = group.scope === null ? copy.scopes.none : scopeName(group.scope, hobs);
      const where = more.length === 0 ? name : copy.export.more({ name, count: more.length });
      rows.push({ skill: row.skill, scope: group.scope, where });
    }
  }
  return { rows, notExported: sortSkills(notExported) };
};

const sortSkills = (all: ReadonlyArray<Skill>) => [...all].sort((a, b) => a.name.localeCompare(b.name));

const sortRows = (rows: ReadonlyArray<SkillRow>) => [...rows].sort((a, b) => a.skill.name.localeCompare(b.skill.name));

/** The revision number a pin names, from a skill's revisions; 0 when it is not among them. */
export const numberOfPin = (revisions: ReadonlyArray<SkillRevision>, pin: SkillRevisionHash): number =>
  revisions.find((revision) => revision.hash === pin)?.number ?? 0;

/** A nav entry for a scope: its name, what it is, and how many skills it gives. */
export interface ScopeEntry {
  readonly key: string;
  readonly scope: SkillScope;
  readonly name: string;
  readonly count: number;
  readonly hob: Agent | undefined;
}

/** The scopes beside the page: Everyone and each project under Shared, then each hob that has a skill or exists. */
export const scopeEntries = (
  list: SkillsList | undefined,
  active: ReadonlyArray<Agent>,
  hobs: HobDirectory,
): { readonly shared: ReadonlyArray<ScopeEntry>; readonly hobs: ReadonlyArray<ScopeEntry> } => {
  const counts = new Map<string, { scope: SkillScope; count: number }>();
  for (const assignment of list?.assignments ?? []) {
    const key = memoryScopeKey(assignment.scope);
    counts.set(key, { scope: assignment.scope, count: (counts.get(key)?.count ?? 0) + 1 });
  }
  const entry = (scope: SkillScope): ScopeEntry => {
    const key = memoryScopeKey(scope);
    return {
      key,
      scope,
      name: scopeName(scope, hobs),
      count: counts.get(key)?.count ?? 0,
      hob: scope._tag === "Hob" ? hobs.get(scope.agentId) : undefined,
    };
  };
  const projects = [...counts.values()]
    .map((one) => one.scope)
    .filter((scope) => scope._tag === "Project")
    .map(entry)
    .sort((a, b) => a.name.localeCompare(b.name));
  const hobScopes = active.map((hob): SkillScope => ({ _tag: "Hob", agentId: hob.id })).map(entry);
  return { shared: [entry({ _tag: "Everyone" }), ...projects], hobs: hobScopes };
};

/** A search's matches: in a skill's name or what it is for, with the part that matched. */
export interface SearchHit {
  readonly skill: Skill;
  readonly before: string;
  readonly hit: string;
  readonly after: string;
}

/** Skills whose name or description holds `q`, ignoring case; the description's match shows when both do. */
export const searchHits = (skills: ReadonlyArray<Skill>, q: string): ReadonlyArray<SearchHit> => {
  const needle = q.trim().toLocaleLowerCase();
  if (needle === "") return [];
  return skills.flatMap((skill) => {
    const at = skill.description.toLocaleLowerCase().indexOf(needle);
    if (at !== -1) {
      const { description } = skill;
      return [
        {
          skill,
          before: description.slice(0, at),
          hit: description.slice(at, at + needle.length),
          after: description.slice(at + needle.length),
        },
      ];
    }
    const named = `${skill.name} ${skillTitle(skill.name)}`.toLocaleLowerCase().includes(needle);
    return named ? [{ skill, before: skill.description, hit: "", after: "" }] : [];
  });
};

const FRONT_MATTER = /^﻿?---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;

/**
 * A `SKILL.md`'s instructions: the text after its front matter, less the blank lines that set it
 * apart. The first line keeps its indentation, which can open a Markdown code block.
 */
export const instructionsOf = (skillFile: string): string =>
  skillFile.replace(FRONT_MATTER, "").replace(/^(?:[ \t]*\r?\n)+/, "");

/** How well a description says when to use the skill, as the editor checks it while you type. */
export const descriptionState = (description: string): "short" | "long" | "good" => {
  const length = description.trim().length;
  if (length > SKILL_DESCRIPTION_MAX) return "long";
  return length < 40 ? "short" : "good";
};

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Whether `name` is a skill name: lower-case letters, digits and single hyphens, at most 64. */
export const nameValid = (name: string): boolean => name.length <= 64 && NAME.test(name);

/** A name typed as a title, made a skill name: "Release steps" becomes `release-steps`. */
export const nameOf = (typed: string): string =>
  typed
    .trim()
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);

/** A new skill's `SKILL.md`. The description is written as a quoted YAML string, so any text is safe in it. */
export const newSkillFile = (name: string, description: string, instructions: string): string => {
  const body = instructions.trim();
  return `---\nname: ${name}\ndescription: ${JSON.stringify(description.trim())}\n---\n\n${body === "" ? "" : `${body}\n`}`;
};

/** How a revision's files differ from the one before it, `SKILL.md` aside. */
export const fileChanges = (
  revision: SkillRevision,
  previous: SkillRevision,
): { readonly added: number; readonly removed: number; readonly changed: number } => {
  const before = new Map(previous.files.map((file) => [file.path, file.sha256]));
  const after = new Map(revision.files.map((file) => [file.path, file.sha256]));
  let added = 0;
  let changed = 0;
  for (const [path, sha] of after) {
    if (path === "SKILL.md") continue;
    if (!before.has(path)) added += 1;
    else if (before.get(path) !== sha) changed += 1;
  }
  const removed = [...before.keys()].filter((path) => path !== "SKILL.md" && !after.has(path)).length;
  return { added, removed, changed };
};

/**
 * Whether a scan's skill can be imported as a new skill: it passed, the library has no skill of its
 * name, and each older revision an export brings with it passed too and is still that revision.
 */
export const importable = (candidate: {
  readonly refusal: unknown;
  readonly existing: { readonly number: number | null } | null;
  readonly exported?: {
    readonly older: ReadonlyArray<{ readonly matches: boolean; readonly refusal: unknown }>;
  } | null;
}): boolean =>
  candidate.refusal === null &&
  candidate.existing === null &&
  (candidate.exported?.older ?? []).every((older) => older.matches && older.refusal === null);
