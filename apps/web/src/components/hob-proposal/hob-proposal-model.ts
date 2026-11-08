import {
  type AgentId,
  type CharmOperationId,
  DEFAULT_SIGIL,
  HobColor,
  type HobProposal,
  type HobProposalRow,
  RUNTIME_NAMES,
  SUMMONING_CHARM,
  type SummoningDraft,
  starterRole,
} from "@hobbots/domain";
import { type FirstHobDraft, newDraft } from "../../api/first-hob.ts";
import { messages } from "./messages.ts";

const copy = messages;

/** What a proposal asks, in one line: "Bram proposes 3 new hobs". */
export const hobProposalWhat = (proposal: HobProposal, who: string): string => {
  const first = proposal.rows[0]?.label ?? "";
  switch (proposal.kind) {
    case "summon":
      return copy.what.summon({ who, count: proposal.rows.length });
    case "change":
      return proposal.rows.length === 1 && proposal.rows[0]?.hobId === proposal.agentId
        ? copy.what.self({ who })
        : copy.what.change({ who, count: proposal.rows.length });
    case "pause":
      return copy.what.pause({ who, hob: first });
    case "wake":
      return copy.what.wake({ who, hob: first });
    default:
      return copy.what.retire({ who, hob: first });
  }
};

/** The rows still waiting for you, less those whose hob changed since, which can only be denied. */
export const allowableRows = (proposal: HobProposal, changedSince: ReadonlyArray<string>) =>
  proposal.rows.filter((row) => row.state === "pending" && !changedSince.includes(row.id));

const OPERATION_WORDS: ReadonlyMap<string, string> = new Map(
  SUMMONING_CHARM.operations.map((operation) => [operation.id, operation.words]),
);

/** How an operation reads after "Always allow": "summoning new hobs". */
export const operationWords = (operation: CharmOperationId): string => OPERATION_WORDS.get(operation) ?? operation;

/** The operations "Always allow" may still set to Allow: those that asked, not yet set. */
export const alwaysOffers = (proposal: HobProposal): ReadonlyArray<CharmOperationId> =>
  proposal.state === "open" ? proposal.asks.filter((operation) => !proposal.alwaysAllowed.includes(operation)) : [];

/** The hobs a proposal made: each summon row you allowed, to open from its created card. */
export const createdHobs = (
  proposal: HobProposal,
): ReadonlyArray<{ readonly hobId: AgentId; readonly name: string; readonly row: HobProposalRow }> =>
  proposal.kind === "summon"
    ? proposal.rows
        .filter((row) => row.state === "allowed")
        .map((row) => ({ hobId: row.hobId, name: (row.edited ?? row.draft)?.name ?? row.label, row }))
    : [];

/** The draft a summon row makes: yours when you edited it, else the manager's. */
export const rowDraft = (row: HobProposalRow): SummoningDraft => row.edited ?? row.draft ?? {};

/** The role a draft names, in words: the title it gives, else its starter role's. */
const roleTitle = (draft: Pick<SummoningDraft, "role" | "role_title">): string =>
  draft.role_title ?? (draft.role === undefined || draft.role === null ? copy.noValue : starterRole(draft.role).title);

/** The brain a draft names: "Codex · gpt-5 · high", with what it leaves out as the default. */
const brainWords = (draft: Pick<SummoningDraft, "runtime" | "model" | "effort">, fallback?: string): string => {
  const runtime = draft.runtime === undefined ? fallback : RUNTIME_NAMES[draft.runtime];
  return [
    runtime,
    draft.model ?? copy.defaultModel,
    draft.effort === undefined || draft.effort === null ? copy.defaultEffort : draft.effort,
  ]
    .filter((part): part is string => part !== undefined)
    .join(" · ");
};

/** The sprite a summon row shows: the look the hub drew for it when it was proposed. */
export const rowLook = (draft: SummoningDraft) => {
  const lookSeed = draft.look_seed ?? 0;
  return {
    lookSeed,
    lookColor: draft.look_color ?? (HobColor.literals[lookSeed % HobColor.literals.length] as HobColor),
    hat: draft.hat ?? null,
    tool: draft.tool ?? null,
    sigil: draft.sigil ?? draft.role ?? DEFAULT_SIGIL,
  };
};

const list = (items: ReadonlyArray<string> | undefined) =>
  items === undefined ? undefined : items.length === 0 ? copy.noValue : items.join(", ");

/**
 * The facts a summon row shows under its name: role, good at, brain, folders, Charms and answers,
 * each only when the draft gives it, except the role and brain, which every hob has.
 */
export const summonFacts = (draft: SummoningDraft): ReadonlyArray<readonly [string, string]> => {
  const facts: Array<readonly [string, string | undefined]> = [
    [copy.fields.role, roleTitle(draft)],
    [copy.fields.goodAt, draft.good_at ?? undefined],
    [copy.fields.brain, brainWords(draft)],
    [copy.fields.folders, list(draft.own_folders)],
    [copy.fields.hidden, list(draft.hidden_shared_folders)],
    [copy.fields.charms, list(draft.charms)],
    [
      copy.fields.answers,
      draft.answers === undefined ? copy.yourAnswers : copy.answerCount({ count: Object.keys(draft.answers).length }),
    ],
  ];
  return facts.filter((fact): fact is readonly [string, string] => fact[1] !== undefined);
};

/** How the profile names each field a change gives, by the change's own key. */
const CHANGE_LABELS: Readonly<Record<string, string>> = {
  name: copy.fields.name,
  role: copy.fields.role,
  role_title: copy.fields.role,
  good_at: copy.fields.goodAt,
  sigil: copy.fields.sigil,
  hat: copy.fields.hat,
  tool: copy.fields.tool,
  look_seed: copy.fields.look,
  look_color: copy.fields.look,
  voice: copy.fields.voice,
  length: copy.fields.length,
  instructions: copy.fields.instructions,
  runtime: copy.fields.brain,
  model: copy.fields.brain,
  effort: copy.fields.effort,
  own_folders: copy.fields.folders,
  hidden_shared_folders: copy.fields.hidden,
  charms: copy.fields.charms,
  answers: copy.fields.answers,
};

/** A field's value in a few words, as a before or an after shows it. */
const valueWords = (value: unknown): string => {
  if (value === undefined || value === null || value === "") return copy.noValue;
  if (Array.isArray(value)) return value.length === 0 ? copy.noValue : value.map(String).join(", ");
  if (typeof value === "object") return copy.answerCount({ count: Object.keys(value).length });
  if (typeof value === "string" && value in RUNTIME_NAMES) return RUNTIME_NAMES[value as keyof typeof RUNTIME_NAMES];
  return String(value);
};

/** One line of a change row: the field, as it is now, and as the change sets it. */
export interface ChangeLine {
  readonly key: string;
  readonly label: string;
  readonly before: string;
  readonly after: string;
  /** Instructions are long: the card folds them. */
  readonly long: boolean;
}

/** The before and after of each field a change row gives, in the change's order. */
export const changeLines = (row: HobProposalRow): ReadonlyArray<ChangeLine> => {
  if (row.change === null) return [];
  const before = row.before ?? {};
  return Object.entries(row.change)
    .filter(([key, value]) => key !== "hob" && value !== undefined)
    .map(([key, value]) => ({
      key,
      label: CHANGE_LABELS[key] ?? key,
      before: valueWords(before[key]),
      after: valueWords(value),
      long: key === "instructions",
    }));
};

/**
 * A summon row as Summon's draft, so Edit opens Summon on it. What Summon does not show (folders,
 * Charms and answers) stays as the row has it, and goes back with your version.
 */
export const summonFormDraft = (row: HobProposalRow, makeId: () => string = () => row.hobId): FirstHobDraft => {
  const draft = rowDraft(row);
  const base = newDraft(Math.random, makeId);
  const role = draft.role === undefined ? base.role : draft.role;
  const gear = role === null ? { hat: null, tool: null } : { hat: starterRole(role).hat, tool: starterRole(role).tool };
  const look = rowLook(draft);
  return {
    ...base,
    role,
    ownTitle: draft.role_title ?? "",
    ownSigil: draft.sigil ?? base.ownSigil,
    hat: draft.hat === undefined ? gear.hat : draft.hat,
    tool: draft.tool === undefined ? gear.tool : draft.tool,
    chores: draft.instructions ?? "",
    choresEdited: true,
    goodAt: draft.good_at ?? "",
    goodAtEdited: draft.good_at !== undefined,
    name: draft.name ?? row.label,
    named: true,
    lookSeed: look.lookSeed,
    lookBase: look.lookSeed,
    lookColor: look.lookColor,
    voice: draft.voice ?? base.voice,
    length: draft.length ?? base.length,
    runtime: draft.runtime ?? base.runtime,
    model: draft.model === undefined ? null : draft.model,
    effort: draft.effort === undefined ? null : draft.effort,
  };
};

/** Your version from Summon as the row's draft, keeping what Summon does not show as the row has it. */
export const editedSummoningDraft = (form: FirstHobDraft, row: HobProposalRow): SummoningDraft => {
  const { own_folders, hidden_shared_folders, charms, answers } = rowDraft(row);
  const goodAt = form.goodAt.trim();
  return {
    name: form.name.trim(),
    ...(form.role === null
      ? { role: null, role_title: form.ownTitle.trim(), sigil: form.ownSigil }
      : { role: form.role }),
    hat: form.hat,
    tool: form.tool,
    good_at: goodAt === "" ? null : goodAt,
    look_seed: form.lookSeed,
    look_color: form.lookColor,
    voice: form.voice,
    length: form.length,
    instructions: form.chores,
    runtime: form.runtime,
    model: form.model === null || form.model === "default" ? null : form.model,
    effort: form.effort,
    ...(own_folders === undefined ? {} : { own_folders }),
    ...(hidden_shared_folders === undefined ? {} : { hidden_shared_folders }),
    ...(charms === undefined ? {} : { charms }),
    ...(answers === undefined ? {} : { answers }),
  };
};
