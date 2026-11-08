import { Schema } from "effect";
import { AgentId } from "./ids.ts";
import { MemoryProjectIdentity } from "./memory.ts";

/**
 * A repository's own skills (ADR 029, Scopes, #1098): a repository a hob works in may hold skills in
 * `.claude/skills` or `.agents/skills`. They are a source, not a scope: no hob loads them from the
 * checkout, where a branch or a pull request could change them under a running hob. Hobbots offers
 * them once per project, and an import reads them from the repository's default branch into that
 * project's scope, where they get revisions, checks and updates like any skill from Git.
 */

/** The folders of a repository that hold its own skills, from its top. */
export const REPOSITORY_SKILL_ROOTS = [".claude/skills", ".agents/skills"] as const;

/**
 * Whether a folder a scan of the repository found is one of its own skills: a skill in one of
 * `REPOSITORY_SKILL_ROOTS`, or the set they make when they share files, which is named by the folder
 * above `skills` (ADR 029, Skill sets).
 */
export const isRepositorySkill = (folder: string): boolean =>
  REPOSITORY_SKILL_ROOTS.some((root) => folder.startsWith(`${root}/`) || folder === root.slice(0, root.indexOf("/")));

/**
 * A repository a hob works in that holds skills of its own: its project, the clone the hob works in,
 * the `origin` an import reads it from, a hob that works in it, and the skill folders the clone holds
 * now, as `.claude/skills/triage`. `offered` is whether Hobbots still offers them: it is false once
 * you imported them or said Not now, until the repository holds a skill folder it did not then.
 */
export const SkillRepository = Schema.Struct({
  project: MemoryProjectIdentity,
  folder: Schema.String,
  url: Schema.String,
  agentId: AgentId,
  skills: Schema.Array(Schema.String),
  offered: Schema.Boolean,
});
export type SkillRepository = typeof SkillRepository.Type;

/**
 * Whether a repository's skills are offered: some skill folder it holds now was not there when you
 * last imported or said Not now. Never closed is always offered.
 */
export const repositoryOffered = (skills: ReadonlyArray<string>, closed: ReadonlyArray<string> | null): boolean =>
  skills.length > 0 && (closed === null || skills.some((folder) => !closed.includes(folder)));

/** How many skills the folders name, once each by name: one skill in both roots counts once. */
export const repositorySkillCount = (skills: ReadonlyArray<string>): number =>
  new Set(skills.map((folder) => folder.slice(folder.lastIndexOf("/") + 1))).size;
