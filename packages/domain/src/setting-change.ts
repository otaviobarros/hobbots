import { Schema } from "effect";
import { Actor } from "./actor.ts";
import type { HobPolicy } from "./policy.ts";
import { type InstallationSetup, SafetyPreset } from "./setup.ts";
import { SummoningForEveryHob, summoningForEveryHobReaches } from "./summoning.ts";

/**
 * The hub settings that change what hobs may do (#1357): the safety preset, the shared folders and
 * "Summoning for every hob" (ADR 034). Every change to one is kept with who made it, when, and the
 * value before and after.
 */
export const AuthoritySetting = Schema.Literals(["safetyPreset", "approvedFolders", "summoningForEveryHob"]);
export type AuthoritySetting = typeof AuthoritySetting.Type;

const SafetyPresetDiff = Schema.Struct({
  setting: Schema.Literal("safetyPreset"),
  before: SafetyPreset,
  after: SafetyPreset,
});
const FoldersDiff = Schema.Struct({
  setting: Schema.Literal("approvedFolders"),
  before: Schema.Array(Schema.String),
  after: Schema.Array(Schema.String),
});
const EveryHobDiff = Schema.Struct({
  setting: Schema.Literal("summoningForEveryHob"),
  before: Schema.NullOr(SummoningForEveryHob),
  after: Schema.NullOr(SummoningForEveryHob),
});

/** One authority setting's value before and after a change. */
export const SettingDiff = Schema.Union([SafetyPresetDiff, FoldersDiff, EveryHobDiff]);
export type SettingDiff = typeof SettingDiff.Type;

/** A change to an authority setting: who made it, when, and the value before and after (#1357). */
export const SettingChange = Schema.Struct({
  id: Schema.String,
  /** ISO time of the change. */
  at: Schema.String,
  actor: Actor,
  diff: SettingDiff,
});
export type SettingChange = typeof SettingChange.Type;

const samePreset = Schema.toEquivalence(SafetyPreset);
const sameFolders = Schema.toEquivalence(Schema.Array(Schema.String));
const sameEveryHob = Schema.toEquivalence(Schema.NullOr(SummoningForEveryHob));

/**
 * What a setup change did to the authority settings: one diff for each whose value changed, in the
 * order Settings shows them. Answers that only moved within the stored value count as no change.
 */
export const settingDiffs = (before: InstallationSetup, after: InstallationSetup): ReadonlyArray<SettingDiff> => [
  ...(samePreset(before.safetyPreset, after.safetyPreset)
    ? []
    : [{ setting: "safetyPreset" as const, before: before.safetyPreset, after: after.safetyPreset }]),
  ...(sameFolders(before.approvedFolders, after.approvedFolders)
    ? []
    : [{ setting: "approvedFolders" as const, before: before.approvedFolders, after: after.approvedFolders }]),
  ...(sameEveryHob(before.summoningForEveryHob, after.summoningForEveryHob)
    ? []
    : [
        {
          setting: "summoningForEveryHob" as const,
          before: before.summoningForEveryHob,
          after: after.summoningForEveryHob,
        },
      ]),
];

/**
 * Whether a setting change reached a hob, judged by the policy the hob held when it was made: the
 * preset and the shared folders reach every hob; "Summoning for every hob" reaches a hob you made
 * that neither held the Charm on its own nor was withheld it (ADR 034).
 */
export const settingReaches = (
  diff: SettingDiff,
  hob: { readonly policy: HobPolicy; readonly summonedBy: string | null },
): boolean => diff.setting !== "summoningForEveryHob" || summoningForEveryHobReaches(hob);
