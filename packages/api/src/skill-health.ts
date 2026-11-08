import {
  AgentId,
  RuntimeKind,
  SkillAssignmentId,
  SkillId,
  SkillName,
  SkillRevisionHash,
  SkillScope,
} from "@hobbots/domain";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { DeviceSession } from "./user-session.ts";

/**
 * The Skills Overview's health checks (ADR 029, Health checks, #1099): what in the library deserves a
 * look, each with a way to act on it, and how much each hob carries. Worked out by the hub from the
 * library, its uses and each hob's skills as its next turn would get them, the same on every runtime.
 */

/** How long a skill goes unused before the Overview asks whether it is still worth its place. */
export const SKILL_UNUSED_DAYS = 60;

/**
 * A description past this many characters is long enough to crowd a hob's listing: the runtime reads
 * every skill's name and description before each turn, within a budget.
 */
export const SKILL_DESCRIPTION_LONG = 500;

/**
 * The characters a hob's listing of skills may take before the runtime starts dropping descriptions:
 * Claude Code's documented fallback for its skill listing budget. Codex documents none, so the same
 * figure is the yardstick for every runtime.
 */
export const SKILL_LISTING_BUDGET = 8000;

/** A skill some place uses that no hob used in `SKILL_UNUSED_DAYS` days. */
export const UnusedSkill = Schema.Struct({
  skillId: SkillId,
  name: SkillName,
  /** Its last use, or null when no hob ever used it. */
  lastUsedAt: Schema.NullOr(Schema.String),
  /** How many places get it, which Remove from each takes it off. */
  assignments: Schema.Int,
});

/** A place on an older revision than the skill's newest, held there or not. */
export const BehindAssignment = Schema.Struct({
  assignmentId: SkillAssignmentId,
  skillId: SkillId,
  name: SkillName,
  scope: SkillScope,
  pin: SkillRevisionHash,
  /** The revision it is on, or null when the library no longer has it. */
  number: Schema.NullOr(Schema.Int),
  latest: Schema.Int,
  held: Schema.Boolean,
});

/**
 * Two skills of one name a hob gets: two of its projects define it, so neither loads (`projects`);
 * another skill of the name replaces one for it (`replaced`); or both load from one scope, so `/name`
 * picks neither (`same-scope`).
 */
export const SkillClashKind = Schema.Literals(["projects", "replaced", "same-scope"]);
export type SkillClashKind = typeof SkillClashKind.Type;

export const SkillClash = Schema.Struct({
  agentId: AgentId,
  name: SkillName,
  kind: SkillClashKind,
  skillIds: Schema.Array(SkillId),
});

/** Why a description may keep its skill from being picked: it says nothing of when to use it, or it is long. */
export const DescriptionProblem = Schema.Literals(["vague", "long"]);
export type DescriptionProblem = typeof DescriptionProblem.Type;

/** A skill, or a skill of a set, whose newest description may keep it from triggering well. */
export const DescriptionCheck = Schema.Struct({
  skillId: SkillId,
  name: SkillName,
  /** The set it is in, for a skill of a set; null otherwise. */
  set: Schema.NullOr(SkillName),
  problem: DescriptionProblem,
  length: Schema.Int,
});

/** What a hob carries: how many skills, and how much of its listing their names and descriptions take. */
export const SkillLoad = Schema.Struct({
  agentId: AgentId,
  runtime: RuntimeKind,
  skills: Schema.Int,
  /** The characters the runtime lists, Only when asked skills left out, since no runtime lists them. */
  characters: Schema.Int,
  budget: Schema.Int,
});
export type SkillLoad = typeof SkillLoad.Type;

export const SkillHealth = Schema.Struct({
  unused: Schema.Array(UnusedSkill),
  behind: Schema.Array(BehindAssignment),
  clashes: Schema.Array(SkillClash),
  descriptions: Schema.Array(DescriptionCheck),
  loads: Schema.Array(SkillLoad),
});
export type SkillHealth = typeof SkillHealth.Type;

export class SkillHealthGroup extends HttpApiGroup.make("skillHealth")
  .add(HttpApiEndpoint.get("get", "/skill-health", { success: SkillHealth }))
  .middleware(DeviceSession)
  .prefix("/api") {}
