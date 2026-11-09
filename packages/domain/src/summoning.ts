import { Schema } from "effect";
import { Effort, RuntimeKind } from "./agent.ts";
import { HobColor, LookSeed } from "./look.ts";
import {
  type CharmDeclaration,
  CharmId,
  type CharmOperation,
  type CharmOperationId,
  CharmOverrides,
  DEFAULT_HOB_CHARMS,
  DEFAULT_SUMMONING_SCOPE,
  type HobPolicy,
  holdsCharm,
  PolicyLayer,
  SummoningScope,
} from "./policy.ts";
import { RoleHat, RoleId, RoleTool } from "./roles.ts";
import { toolInputJsonSchema } from "./task-tools.ts";
import { ReplyLength, Voice } from "./tone.ts";

/**
 * The Summoning Charm (ADR 034): a built-in Charm with which a hob summons, changes, pauses, wakes
 * and retires hobs, within the scope and field answers you set, and never wider than itself. Only you
 * grant it, scope it or take it away; no hob can, its own included.
 */

export const SUMMONING_CHARM_ID = "summoning";

/** The Charm's name, as the Charms tab and the roster of other hobs show it. */
export const SUMMONING_CHARM_NAME = "Summoning";

/** Every answer of the Charm's operations under every preset: Allow, narrowed by the defaults below. */
const ALLOW = { careful: "allow", balanced: "allow", trusting: "allow" } as const;

const operation = (id: CharmOperationId, words: string, onceOnly = false): CharmOperation => ({
  id,
  words,
  presets: ALLOW,
  // No site: a grant could name nothing narrower than the operation, so each asks once only (ADR 015).
  site: [],
  onceOnly,
  actsAsIdentity: false,
});

/** The fields of a hob that the Charm's tools set, each decided on its own operation. */
export const SummoningField = Schema.Literals([
  "name",
  "role",
  "good-at",
  "look",
  "sigil",
  "hat",
  "tool",
  "voice",
  "length",
  "instructions",
  "brain",
  "effort",
  "folders",
  "charms",
]);
export type SummoningField = typeof SummoningField.Type;

/** The fields a hob managing itself may change, each on its own `self-` operation. */
export const SelfField = Schema.Literals(["name", "good-at", "look", "voice", "brain", "instructions"]);
export type SelfField = typeof SelfField.Type;

/** How the hub words each field in a reason, such as "a hob's good at". */
export const SUMMONING_FIELD_WORDS: Readonly<Record<SummoningField, string>> = {
  name: "a hob's name",
  role: "a hob's role",
  "good-at": "what a hob is good at",
  look: "a hob's look",
  sigil: "a hob's sigil",
  hat: "a hob's hat",
  tool: "the tool a hob's sprite holds",
  voice: "a hob's voice",
  length: "a hob's reply length",
  instructions: "a hob's instructions",
  brain: "a hob's runtime and model",
  effort: "a hob's effort",
  folders: "a hob's folders",
  charms: "a hob's Charms and operation answers",
};

const SELF_WORDS: Readonly<Record<SelfField, string>> = {
  name: "its own name",
  "good-at": "what it is good at",
  look: "its own look",
  voice: "its own voice and reply length",
  brain: "its own brain",
  instructions: "its own instructions",
};

export const summoningFieldOperation = (field: SummoningField): CharmOperationId => `summoning.${field}`;
export const selfFieldOperation = (field: SelfField): CharmOperationId => `summoning.self-${field}`;
export const SUMMON_OPERATION: CharmOperationId = "summoning.summon";
export const PAUSE_OPERATION: CharmOperationId = "summoning.pause";
export const RETIRE_OPERATION: CharmOperationId = "summoning.retire";

/**
 * The Summoning Charm as it declares itself to the policy (ADR 034): one operation per field,
 * mirroring Summon and the profile, and summon, pause and wake, retire, and the fields a hob managing
 * itself may change. Every one is Allow under every preset, so an override can still set any of them
 * to Allow; granting the Charm writes the defaults as narrowing overrides. Retire is high risk: once
 * only, with the confirmation check box, under every answer but Never.
 */
export const SUMMONING_CHARM: CharmDeclaration = {
  id: SUMMONING_CHARM_ID,
  operations: [
    operation(SUMMON_OPERATION, "summoning new hobs"),
    ...SummoningField.literals.map((field) =>
      operation(summoningFieldOperation(field), `changing ${SUMMONING_FIELD_WORDS[field]}`),
    ),
    operation(PAUSE_OPERATION, "pausing and waking hobs"),
    operation(RETIRE_OPERATION, "retiring hobs", true),
    ...SelfField.literals.map((field) => operation(selfFieldOperation(field), `changing ${SELF_WORDS[field]}`)),
  ],
  takesOver: [],
};

/** The answers granting the Charm writes as overrides (ADR 034): every field the table sets to Ask. */
export const SUMMONING_DEFAULTS: CharmOverrides = {
  [SUMMON_OPERATION]: "ask",
  [summoningFieldOperation("role")]: "ask",
  [summoningFieldOperation("good-at")]: "ask",
  [summoningFieldOperation("instructions")]: "ask",
  [summoningFieldOperation("brain")]: "ask",
  [summoningFieldOperation("effort")]: "ask",
  [summoningFieldOperation("folders")]: "ask",
  [summoningFieldOperation("charms")]: "ask",
};

/** The answers turning "Can manage itself" on writes as overrides: every self field asks (ADR 034). */
export const SUMMONING_SELF_DEFAULTS: CharmOverrides = Object.fromEntries(
  SelfField.literals.map((field) => [selfFieldOperation(field), "ask"] as const),
);

/**
 * The Summoning Charm granted to every hob you made (ADR 034): one scope and one set of answers,
 * off when null. It never reaches a hob that a hob summoned, and a hob's own Charms tab can take it
 * away from that hob, or grant it with its own scope and answers.
 */
export const SummoningForEveryHob = Schema.Struct({
  scope: SummoningScope,
  overrides: CharmOverrides,
});
export type SummoningForEveryHob = typeof SummoningForEveryHob.Type;

/** The Summoning Charm's scope a hob's policy holds: its own, or the default. */
export const summoningScopeOf = (policy: HobPolicy): SummoningScope =>
  policy.charms?.summoning ?? DEFAULT_SUMMONING_SCOPE;

/**
 * The policy a hob runs under once "Summoning for every hob" applies (ADR 034): a hob you made that
 * does not hold the Charm and was not withheld it gets it, with the setting's scope and answers.
 * A hob a hob summoned, one that holds it on its own, and one you took it away from are unchanged.
 */
export const withSummoningForEveryHob = (
  hob: { readonly policy: HobPolicy; readonly summonedBy: string | null },
  everyHob: SummoningForEveryHob | null,
): HobPolicy => {
  const { policy } = hob;
  if (everyHob === null || hob.summonedBy !== null || holdsCharm(policy, SUMMONING_CHARM_ID)) return policy;
  if (policy.charms?.withheld?.includes(SUMMONING_CHARM_ID)) return policy;
  const granted = [...(policy.charms?.granted ?? DEFAULT_HOB_CHARMS), SUMMONING_CHARM_ID];
  const overrides: CharmOverrides = { ...everyHob.overrides, ...policy.charms?.overrides };
  return { ...policy, charms: { ...policy.charms, granted, overrides, summoning: everyHob.scope } };
};

/**
 * The caps on summons that run without asking you (ADR 034): live hobs one manager summoned
 * without a card, and live hobs summoned without a card for one Task tree. A summon you approve on
 * a card is never counted, and the hub has no cap on its number of hobs.
 */
export interface SummonLimits {
  readonly maxUnattendedPerHob: number;
  readonly maxUnattendedPerTree: number;
}

export const DEFAULT_SUMMON_LIMITS: SummonLimits = { maxUnattendedPerHob: 4, maxUnattendedPerTree: 3 };

/** What the caps count of a hob: who summoned it, for which Task, without a card or not, and its status. */
type CountedHob = {
  readonly status: string;
  readonly summonedBy: string | null;
  readonly summonedFor: string | null;
  readonly summonedUnattended: boolean;
};

/** Whether a hob takes a place under the caps: summoned without a card and not retired, so retiring frees it. */
const holdsUnattendedPlace = (hob: CountedHob) => hob.summonedUnattended && hob.status !== "retired";

/** Live hobs `managerId` summoned without a card. */
export const unattendedSummonsBy = (hobs: ReadonlyArray<CountedHob>, managerId: string): number =>
  hobs.filter((hob) => holdsUnattendedPlace(hob) && hob.summonedBy === managerId).length;

/** Live hobs summoned without a card for any of a Task tree's Tasks. */
export const unattendedSummonsIn = (hobs: ReadonlyArray<CountedHob>, taskIds: ReadonlySet<string>): number =>
  hobs.filter((hob) => holdsUnattendedPlace(hob) && hob.summonedFor !== null && taskIds.has(hob.summonedFor)).length;

/**
 * A hob's unattended summons against the caps, for the Charms tab: the live hobs it summoned
 * without a card, and the two caps the hub holds them to.
 */
export const SummonCaps = Schema.Struct({
  live: Schema.Int,
  perHob: Schema.Int,
  perTree: Schema.Int,
});
export type SummonCaps = typeof SummonCaps.Type;

/** The Summoning Charm's tools (ADR 034), named `summoning_<action>` as every built-in Charm's are (ADR 031). */
export const SUMMONING_CHECK_TOOL = "summoning_check";
export const SUMMONING_SUMMON_TOOL = "summoning_summon";
export const SUMMONING_CHANGE_TOOL = "summoning_change";
export const SUMMONING_PAUSE_TOOL = "summoning_pause";
export const SUMMONING_WAKE_TOOL = "summoning_wake";
export const SUMMONING_RETIRE_TOOL = "summoning_retire";

const text = (description: string) => Schema.String.check(Schema.isNonEmpty()).annotate({ description });
const optional = <S extends Schema.Top>(schema: S, description: string) =>
  Schema.optionalKey(schema.annotate({ description }));

const hobRef = text("The hob's name or id.");

/** A hob's fields as a summon draft or a change gives them, each optional. */
const hobFields = {
  name: optional(Schema.String, "The hob's name."),
  role: optional(
    Schema.NullOr(RoleId),
    "A starter role's id, which brings its title, or null for a title in your own words.",
  ),
  role_title: optional(Schema.String, "The role's title: a starter role's, or your own words."),
  good_at: optional(
    Schema.NullOr(Schema.String),
    "One line of up to 200 characters on when other hobs should come to this hob.",
  ),
  sigil: optional(RoleId, "The starter role whose sigil the hob shows."),
  hat: optional(Schema.NullOr(RoleHat), "The hat its sprite wears, or null to leave it to the look."),
  tool: optional(Schema.NullOr(RoleTool), "The tool its sprite holds, or null to leave it to the look."),
  look_seed: optional(LookSeed, "The seed its sprite is drawn from."),
  look_color: optional(HobColor, "Its colour."),
  voice: optional(Voice, "How it talks."),
  length: optional(ReplyLength, "How long its replies are."),
  instructions: optional(Schema.String.check(Schema.isMaxLength(20_000)), "Its instructions."),
  runtime: optional(RuntimeKind, "The runtime it thinks with."),
  model: optional(Schema.NullOr(Schema.String), "A model the runtime offers, or null for its default."),
  effort: optional(Schema.NullOr(Effort), "An effort the model accepts, or null for its default."),
  own_folders: optional(
    Schema.Array(Schema.String),
    "Its own folders: each one of your own folders or inside one, never wider.",
  ),
  hidden_shared_folders: optional(Schema.Array(Schema.String), "Shared folders hidden from it."),
  charms: optional(
    Schema.Array(CharmId),
    "The ids of the Charms it holds: only Charms you hold, never summoning. Left out on a summon, it holds none.",
  ),
  answers: optional(
    PolicyLayer,
    "allow, ask or deny per operation, a built-in one by name or a Charm's by id: each at least as narrow as your own. Left out, it gets your answers.",
  ),
};

export const SummoningDraft = Schema.Struct(hobFields);
export type SummoningDraft = typeof SummoningDraft.Type;

export const SummoningChange = Schema.Struct({ hob: hobRef, ...hobFields });
export type SummoningChange = typeof SummoningChange.Type;

/** The draft fields each field operation decides: a field is set when any of them is given. */
export const DRAFT_FIELDS: Readonly<Record<SummoningField, ReadonlyArray<keyof SummoningDraft>>> = {
  name: ["name"],
  role: ["role", "role_title"],
  "good-at": ["good_at"],
  look: ["look_seed", "look_color"],
  sigil: ["sigil"],
  hat: ["hat"],
  tool: ["tool"],
  voice: ["voice"],
  length: ["length"],
  instructions: ["instructions"],
  brain: ["runtime", "model"],
  effort: ["effort"],
  folders: ["own_folders", "hidden_shared_folders"],
  charms: ["charms", "answers"],
};

/** The field operation a hob managing itself decides a field on, or null for a field it may never change. */
export const SELF_FIELD_OF: Readonly<Record<SummoningField, SelfField | null>> = {
  name: "name",
  role: null,
  "good-at": "good-at",
  look: "look",
  sigil: "look",
  hat: "look",
  tool: "look",
  voice: "voice",
  length: "voice",
  instructions: "instructions",
  brain: "brain",
  effort: "brain",
  folders: null,
  charms: null,
};

/** The fields a draft or change sets, in the table's order. */
export const fieldsSet = (draft: SummoningDraft): ReadonlyArray<SummoningField> =>
  SummoningField.literals.filter((field) => DRAFT_FIELDS[field].some((key) => draft[key] !== undefined));

const MAX_HOBS = 10;

export const SummoningInputs = {
  [SUMMONING_CHECK_TOOL]: Schema.Struct({
    summon: optional(Schema.Array(SummoningDraft).check(Schema.isMaxLength(MAX_HOBS)), "Drafts of new hobs."),
    change: optional(Schema.Array(SummoningChange).check(Schema.isMaxLength(MAX_HOBS)), "Drafts of changes."),
  }),
  [SUMMONING_SUMMON_TOOL]: Schema.Struct({
    hobs: Schema.Array(SummoningDraft)
      .check(Schema.isMinLength(1), Schema.isMaxLength(MAX_HOBS))
      .annotate({ description: "The new hobs, each with at least a name and a role." }),
  }),
  [SUMMONING_CHANGE_TOOL]: Schema.Struct({
    changes: Schema.Array(SummoningChange)
      .check(Schema.isMinLength(1), Schema.isMaxLength(MAX_HOBS))
      .annotate({ description: "One change per hob: the hob, and only the fields that change." }),
  }),
  [SUMMONING_PAUSE_TOOL]: Schema.Struct({ hob: hobRef }),
  [SUMMONING_WAKE_TOOL]: Schema.Struct({ hob: hobRef }),
  [SUMMONING_RETIRE_TOOL]: Schema.Struct({
    hob: hobRef,
    running_replies: Schema.Literals(["finish", "stop"]).annotate({
      description: "What happens to its running replies: let them finish, or stop them now.",
    }),
  }),
} as const;

export type SummoningToolName = keyof typeof SummoningInputs;

const NEVER =
  "You can never set a hob's sandbox, commit signing, credentials, GitHub app or the Summoning Charm, and never widen a hob past your own folders, Charms and answers.";

/** The Summoning Charm's tools as a hob is offered them, in order. */
export const SUMMONING_TOOLS: ReadonlyArray<{
  readonly name: SummoningToolName;
  readonly label: string;
  readonly description: string;
}> = [
  {
    name: SUMMONING_CHECK_TOOL,
    label: "Checking hob drafts",
    description: `Check drafts of new hobs or of changes before you make them: per hob, what is missing or invalid, what you may not do, and which fields would ask the user. It changes nothing. ${NEVER}`,
  },
  {
    name: SUMMONING_SUMMON_TOOL,
    label: "Summoning hobs",
    description: `Summon one or more new hobs. Each needs a name and a role; what a draft leaves out takes Summon's default, and it gets your own answers and none of your Charms unless the draft names them. ${NEVER}`,
  },
  {
    name: SUMMONING_CHANGE_TOOL,
    label: "Changing hobs",
    description: `Change one or more hobs within your scope, naming only the fields that change. Managing yourself, you may change your own name, good at, look, voice, brain and instructions. ${NEVER}`,
  },
  { name: SUMMONING_PAUSE_TOOL, label: "Pausing a hob", description: "Pause one hob within your scope." },
  { name: SUMMONING_WAKE_TOOL, label: "Waking a hob", description: "Wake one paused hob within your scope." },
  {
    name: SUMMONING_RETIRE_TOOL,
    label: "Retiring a hob",
    description:
      "Retire one hob within your scope, letting its running replies finish or stopping them. It always asks the user, once. You never retire yourself.",
  },
];

export const summoningToolJsonSchema = (name: SummoningToolName): Record<string, unknown> =>
  toolInputJsonSchema(SummoningInputs[name]);

/** Where a hob's profile opens in the app, for the answer that names a created hob until chat views give it a card. */
export const hobProfilePath = (id: string): string => `/hobs/${id}`;

/**
 * The answers a change writes for the Summoning Charm under the ones it gives (ADR 034): the
 * defaults when it grants the Charm, and the self defaults when it turns "Can manage itself" on, so
 * a stale answer left from an earlier grant never stands in for them.
 */
export const summoningDefaultsFor = (change: {
  readonly granting: boolean;
  readonly selfTurnedOn: boolean;
}): CharmOverrides => ({
  ...(change.granting ? SUMMONING_DEFAULTS : {}),
  ...(change.selfTurnedOn ? SUMMONING_SELF_DEFAULTS : {}),
});
