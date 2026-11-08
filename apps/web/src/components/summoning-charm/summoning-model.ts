import type { UpdateHobPermissionsPayload } from "@hobbots/api";
import {
  type CharmOperationId,
  type CharmOverrides,
  DEFAULT_SUMMONING_SCOPE,
  type HobPolicy,
  heldCharms,
  holdsCharm,
  PAUSE_OPERATION,
  type PolicyDecision,
  RETIRE_OPERATION,
  SUMMON_OPERATION,
  SUMMONING_CHARM,
  SUMMONING_CHARM_ID,
  type SummoningField,
  type SummoningForEveryHob,
  type SummoningScope,
  selfFieldOperation,
  summoningFieldOperation,
  summoningScopeOf,
  withSummoningForEveryHob,
} from "@hobbots/domain";

/**
 * Where a hob's Summoning Charm comes from (ADR 034): its own grant on its Charms tab, "Summoning
 * for every hob" in Settings, or nowhere.
 */
export type SummoningHeld = "own" | "every-hob" | "off";

/** The Summoning Charm as a screen shows it: where it comes from, its scope and an answer per operation. */
export interface SummoningView {
  readonly held: SummoningHeld;
  readonly scope: SummoningScope;
  readonly answers: Readonly<Record<CharmOperationId, PolicyDecision>>;
}

/** The ids of every operation the Summoning Charm declares. */
const OPERATIONS: ReadonlyArray<CharmOperationId> = SUMMONING_CHARM.operations.map((operation) => operation.id);

const isSummoning = (operation: string) => OPERATIONS.includes(operation as CharmOperationId);

/** The answer per operation under `overrides`: every one is Allow under every preset, so an override is the answer. */
const answersFrom = (overrides: CharmOverrides | undefined): Record<CharmOperationId, PolicyDecision> =>
  Object.fromEntries(OPERATIONS.map((operation) => [operation, overrides?.[operation] ?? "allow"])) as Record<
    CharmOperationId,
    PolicyDecision
  >;

/** A field's operation, by the field's name. */
const field = (name: SummoningField) => summoningFieldOperation(name);

/** The groups the field list shows, in order, each with its operations (ADR 034's table). */
const SUMMONING_GROUPS = [
  { id: "new", operations: [SUMMON_OPERATION] },
  { id: "who", operations: [field("name"), field("role"), field("good-at")] },
  { id: "look", operations: [field("look"), field("sigil"), field("hat"), field("tool")] },
  { id: "talk", operations: [field("voice"), field("length")] },
  {
    id: "work",
    operations: [field("instructions"), field("brain"), field("effort"), field("folders"), field("charms")],
  },
  { id: "pause", operations: [PAUSE_OPERATION, RETIRE_OPERATION] },
] as const satisfies ReadonlyArray<{ readonly id: string; readonly operations: ReadonlyArray<CharmOperationId> }>;

/** The group of fields a hob managing itself may change, shown while "Can manage itself" is on. */
const SELF_GROUP = {
  id: "self",
  operations: (["name", "good-at", "look", "voice", "brain", "instructions"] as const).map(selfFieldOperation),
} as const;

export type SummoningGroupId = (typeof SUMMONING_GROUPS)[number]["id"] | typeof SELF_GROUP.id;

/** The groups the field list shows under `scope`: the hob's own fields only while it may manage itself. */
export const shownGroups = (scope: SummoningScope) =>
  scope.self ? [...SUMMONING_GROUPS, SELF_GROUP] : SUMMONING_GROUPS;

/**
 * The answers a field row offers. Retiring is once only with the confirmation check box under every
 * answer but Never (ADR 034), so it offers asking once or Never, and an Ask set through the API shows
 * as asking once.
 */
export const answersFor = (operation: CharmOperationId): ReadonlyArray<PolicyDecision> =>
  operation === RETIRE_OPERATION ? ["allow", "deny"] : ["allow", "ask", "deny"];

/** The answer a row shows: the operation's own, with retiring's Ask shown as the asking once it means. */
export const shownAnswer = (view: SummoningView, operation: CharmOperationId): PolicyDecision => {
  const answer = view.answers[operation] ?? "allow";
  return operation === RETIRE_OPERATION && answer === "ask" ? "allow" : answer;
};

/**
 * The hob's Summoning Charm as its Charms tab shows it: the hob's own grant, or "Summoning for every
 * hob" when that reaches it (a hob you made that does not hold the Charm and was not withheld it).
 */
export const hobSummoning = (
  hob: { readonly policy: HobPolicy; readonly summonedBy: string | null },
  everyHob: SummoningForEveryHob | null,
): SummoningView => {
  const effective = withSummoningForEveryHob(hob, everyHob);
  const held: SummoningHeld = holdsCharm(hob.policy, SUMMONING_CHARM_ID)
    ? "own"
    : holdsCharm(effective, SUMMONING_CHARM_ID)
      ? "every-hob"
      : "off";
  return { held, scope: summoningScopeOf(effective), answers: answersFrom(effective.charms?.overrides) };
};

/** "Summoning for every hob" as Settings shows it: on with its scope and answers, or off with the defaults' shape. */
export const everyHobSummoning = (everyHob: SummoningForEveryHob | null): SummoningView => ({
  held: everyHob === null ? "off" : "own",
  scope: everyHob?.scope ?? DEFAULT_SUMMONING_SCOPE,
  answers: answersFrom(everyHob?.overrides),
});

/** What a screen changes of the Charm: its scope, or one operation's answer. */
export type SummoningEdit =
  | { readonly _tag: "Scope"; readonly scope: SummoningScope }
  | { readonly _tag: "Answer"; readonly operation: CharmOperationId; readonly answer: PolicyDecision };

/** The view after `edit`, as the screen shows it while the change is on its way to the hub. */
const editedView = (view: SummoningView, edit: SummoningEdit): SummoningView =>
  edit._tag === "Scope"
    ? { ...view, scope: edit.scope }
    : { ...view, answers: { ...view.answers, [edit.operation]: edit.answer } };

/** The hob's overrides for the Charms other than Summoning, which a Summoning change keeps as they are. */
const otherOverrides = (policy: HobPolicy): CharmOverrides =>
  Object.fromEntries(Object.entries(policy.charms?.overrides ?? {}).filter(([operation]) => !isSummoning(operation)));

/** Every Summoning answer written out, Allow included, so the defaults a grant writes never stand in for one. */
const allAnswers = (answers: Readonly<Record<CharmOperationId, PolicyDecision>>): CharmOverrides =>
  Object.fromEntries(OPERATIONS.map((operation) => [operation, answers[operation] ?? "allow"]));

/** The Summoning answers that narrow the Charm's own Allow, the only ones a hob's policy needs to hold. */
const narrowedAnswers = (answers: Readonly<Record<CharmOperationId, PolicyDecision>>): CharmOverrides =>
  Object.fromEntries(
    OPERATIONS.flatMap((operation) => {
      const answer = answers[operation] ?? "allow";
      return answer === "allow" ? [] : [[operation, answer] as const];
    }),
  );

/**
 * The change a hob's Charms tab sends for `edit` (ADR 034). A hob with its own grant changes it in
 * place. A hob that has the Charm from "Summoning for every hob" gets its own grant, starting from
 * that setting's scope and answers, every answer written out so the defaults a grant writes never
 * replace one it had. A change that narrows an answer or the scope revokes the grants that relied on
 * it on the hub (ADR 015), and the hob's next call runs under it.
 */
export const hobEditPayload = (
  policy: HobPolicy,
  view: SummoningView,
  edit: SummoningEdit,
): UpdateHobPermissionsPayload => {
  const next = editedView(view, edit);
  if (view.held === "own") {
    return edit._tag === "Scope"
      ? { charms: { summoning: next.scope } }
      : { charms: { overrides: { ...otherOverrides(policy), ...narrowedAnswers(next.answers) } } };
  }
  return {
    charms: {
      granted: [...heldCharms(policy).filter((id) => id !== SUMMONING_CHARM_ID), SUMMONING_CHARM_ID],
      overrides: { ...otherOverrides(policy), ...allAnswers(next.answers) },
      summoning: next.scope,
    },
  };
};

/**
 * The change the Charm's switch sends on a hob's Charms tab. Turning it on brings back what "every
 * hob" gives when it was taken away from this hob, or grants the hob its own, with the defaults the
 * hub writes. Turning it off takes the hob's own grant away, and also withholds what "every hob"
 * gives, so the hob does not get it back from Settings.
 */
export const hobSwitchPayload = (
  hob: { readonly policy: HobPolicy; readonly summonedBy: string | null },
  everyHob: SummoningForEveryHob | null,
  on: boolean,
): UpdateHobPermissionsPayload => {
  const others = heldCharms(hob.policy).filter((id) => id !== SUMMONING_CHARM_ID);
  const withheld = (hob.policy.charms?.withheld ?? []).filter((id) => id !== SUMMONING_CHARM_ID);
  const reached = everyHob !== null && hob.summonedBy === null;
  if (on) return { charms: { withheld, ...(reached ? {} : { granted: [...others, SUMMONING_CHARM_ID] }) } };
  return { charms: { granted: others, ...(reached ? { withheld: [...withheld, SUMMONING_CHARM_ID] } : {}) } };
};

/** "Summoning for every hob" after `edit`, every answer written out, as Settings sends it. */
export const everyHobEditPayload = (view: SummoningView, edit: SummoningEdit): SummoningForEveryHob => {
  const next = editedView(view, edit);
  return { scope: next.scope, overrides: allAnswers(next.answers) };
};

/** "Summoning for every hob" turned on, with the default scope: the hub writes the default answers. */
export const EVERY_HOB_ON: SummoningForEveryHob = { scope: DEFAULT_SUMMONING_SCOPE, overrides: {} };

/** The scope with `hob` added to the hobs you picked, or taken off them. */
export const pickHob = (scope: SummoningScope, hob: string, picked: boolean): SummoningScope => ({
  ...scope,
  hobs: picked ? [...scope.hobs.filter((id) => id !== hob), hob] : scope.hobs.filter((id) => id !== hob),
});
