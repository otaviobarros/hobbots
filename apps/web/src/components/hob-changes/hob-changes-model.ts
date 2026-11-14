import type { UpdateHobPermissionsPayload } from "@hobbots/api";
import {
  type Agent,
  type AgentId,
  type AnyOperation,
  answersToRestore,
  configurationFields,
  DEFAULT_SUMMONING_SCOPE,
  type HobChange,
  heldCharms,
  hobAnswers,
  hobBehind,
  holdsCharm,
  isCharmOperation,
  lengthChoice,
  ROLE_HAT_TITLES,
  ROLE_TOOL_TITLES,
  RUNTIME_NAMES,
  starterRole,
  voiceChoice,
} from "@hobbots/domain";
import { operationLabel } from "../../lib/reply-steps.ts";
import { messages } from "./messages.ts";

const values = messages.values;

export type VersionChange = Extract<HobChange, { readonly _tag: "Version" }>;

/** One field a version changed: its label, and the field before and after as text. */
export interface FieldDiff {
  readonly key: keyof typeof messages.fields;
  readonly label: string;
  readonly before: string;
  readonly after: string;
  /** Shown line by line, as instructions and lists are, instead of before → after on one line. */
  readonly lines: boolean;
}

type Config = ReturnType<typeof configurationFields>;

const lookText = (config: Config) =>
  values.look({
    color: values.colors[config.lookColor] ?? config.lookColor,
    sigil: starterRole(config.sigil).title,
    hat: config.hat === null ? values.fromSeed : ROLE_HAT_TITLES[config.hat],
    tool: config.tool === null ? values.fromSeed : ROLE_TOOL_TITLES[config.tool],
    seed: config.lookSeed,
  });

const rulesText = (config: Config) =>
  Object.entries(hobAnswers(config.policy))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([operation, answer]) =>
      values.rule({ operation: operationLabel(operation as AnyOperation), answer: values.answers[answer] ?? answer }),
    )
    .join("\n");

const listText = (items: ReadonlyArray<string>) => items.join("\n");

const yesNo = (on: boolean) => (on ? values.yes : values.no);

/**
 * Which hobs the hob may manage through the Summoning Charm, one line each, while it holds the
 * Charm or keeps a scope for it. Picked hobs are named by `nameOf`.
 */
const summoningText = (config: Config, nameOf: (id: string) => string) => {
  const kept = config.policy.charms?.summoning;
  if (kept === undefined && !holdsCharm(config.policy, "summoning")) return "";
  const scope = kept ?? DEFAULT_SUMMONING_SCOPE;
  return [
    values.scopeSummoned({ answer: yesNo(scope.summoned) }),
    values.scopeSelf({ answer: yesNo(scope.self) }),
    ...scope.hobs.map((id) => values.scopePicked({ hob: nameOf(id) })),
  ].join("\n");
};

/** Each field the History shows, in the profile's order, as text; `nameOf` names a hob by its id. */
const FIELDS: ReadonlyArray<
  readonly [FieldDiff["key"], (config: Config, nameOf: (id: string) => string) => string, boolean]
> = [
  ["name", (c) => c.name, false],
  ["role", (c) => c.roleTitle, false],
  ["goodAt", (c) => c.goodAt ?? values.none, false],
  ["look", lookText, false],
  ["voice", (c) => voiceChoice(c.voice).title, false],
  ["length", (c) => lengthChoice(c.length).title, false],
  [
    "brain",
    (c) =>
      values.brain({
        runtime: RUNTIME_NAMES[c.runtime],
        model: c.model ?? values.defaultModel,
        effort: c.effort ?? values.defaultEffort,
      }),
    false,
  ],
  ["instructions", (c) => c.instructions, true],
  ["visibleToHobs", (c) => (c.visibleToHobs ? values.shown : values.hidden), false],
  ["ownFolders", (c) => listText(c.policy.ownFolders), true],
  ["hiddenSharedFolders", (c) => listText(c.policy.hiddenSharedFolders), true],
  ["charms", (c) => listText(heldCharms(c.policy).map((id) => values.charms[id] ?? id)), true],
  ["withheldCharms", (c) => listText((c.policy.charms?.withheld ?? []).map((id) => values.charms[id] ?? id)), true],
  ["summoning", summoningText, true],
  ["rules", rulesText, true],
  ["signCommits", (c) => (c.policy.signCommits === true ? values.yes : values.no), false],
];

/**
 * What a version changed, field by field, against the version before it. The first version, which
 * the hob was summoned with, lists every field it set as added. `nameOf` names a hob the change
 * refers to, such as one picked for a Summoning scope.
 */
export const fieldDiffs = (
  change: VersionChange,
  nameOf: (id: string) => string = () => messages.someHob,
): ReadonlyArray<FieldDiff> => {
  const after = configurationFields(change.config);
  const before = change.previous === null ? null : configurationFields(change.previous);
  const byId = (id: string) => id;
  return FIELDS.flatMap(([key, text, lines]) => {
    // Whether the field changed is decided by ids, never by names, which two hobs can share.
    if (before !== null && text(after, byId) === text(before, byId)) return [];
    const show = (name: (id: string) => string) => ({
      after: text(after, name),
      before: before === null ? "" : text(before, name),
    });
    const named = show(nameOf);
    // Hobs with the same name are told apart by the start of their id.
    const shown = named.after === named.before ? show((id) => `${nameOf(id)} (${id.slice(0, 8)})`) : named;
    if (shown.after === "" && shown.before === "") return [];
    return [{ key, label: messages.fields[key], ...shown, lines }];
  });
};

/** Who made a change: you, you on a hob's proposal, or a hob on its own. */
export type ChangeMaker =
  | { readonly kind: "you" }
  | { readonly kind: "proposal"; readonly hobId: AgentId }
  | { readonly kind: "hob"; readonly hobId: AgentId };

export const makerOf = (change: HobChange): ChangeMaker => {
  switch (change.actor._tag) {
    case "You":
      return { kind: "you" };
    case "YouApplyingProposal":
      return { kind: "proposal", hobId: change.actor.hobId };
    case "Hob":
      return { kind: "hob", hobId: change.actor.hobId };
  }
};

/**
 * The answers a Summoning change dropped that the hob still lacks, in words, with the change that
 * brings them back as yours (#1352); null when there is nothing to restore.
 */
export const restoreOf = (
  change: HobChange,
  hob: Pick<Agent, "policy"> | undefined,
): { readonly words: string; readonly payload: UpdateHobPermissionsPayload } | null => {
  if (hob === undefined) return null;
  const restore = Object.entries(answersToRestore(change, hob.policy)).sort(([a], [b]) => a.localeCompare(b));
  if (restore.length === 0) return null;
  const words = restore
    .map(([operation, answer]) =>
      values.rule({ operation: operationLabel(operation as AnyOperation), answer: values.answers[answer] ?? answer }),
    )
    .join(", ");
  const builtIn = restore.filter(([operation]) => !isCharmOperation(operation as AnyOperation));
  const charm = restore.filter(([operation]) => isCharmOperation(operation as AnyOperation));
  const payload: UpdateHobPermissionsPayload = {
    ...(builtIn.length === 0 ? {} : { overrides: { ...hob.policy.overrides, ...Object.fromEntries(builtIn) } }),
    ...(charm.length === 0
      ? {}
      : { charms: { overrides: { ...hob.policy.charms?.overrides, ...Object.fromEntries(charm) } } }),
  };
  return { words, payload };
};

/** Whether the change can be reverted now: the hob's latest version, and not the one it was summoned with. */
export const canRevert = (change: HobChange, hob: Pick<Agent, "configVersion"> | undefined): boolean =>
  change._tag === "Version" &&
  change.config.version > 1 &&
  hob !== undefined &&
  hob.configVersion === change.config.version;

/** The Changes log's filters; null shows every value. `actor` is "you" or the hob behind the change. */
export interface ChangeFilters {
  readonly hob: AgentId | null;
  readonly actor: "you" | AgentId | null;
  /** A Charm's name, or "" for changes made through none. */
  readonly charm: string | null;
}

export const NO_FILTERS: ChangeFilters = { hob: null, actor: null, charm: null };

/**
 * The Changes log's filters as they sit in the address (STD-REACT-002): `?hob=`, `?by=` ("you" or a
 * hob's id) and `?charm=`, where "none" is the changes made through no Charm.
 */
export interface ChangesSearch {
  readonly hob?: string | undefined;
  readonly by?: string | undefined;
  readonly charm?: string | undefined;
}

const NO_CHARM = "none";

export const filtersFromSearch = (search: ChangesSearch): ChangeFilters => ({
  hob: search.hob === undefined ? null : (search.hob as AgentId),
  actor: search.by === undefined ? null : (search.by as ChangeFilters["actor"]),
  charm: search.charm === undefined ? null : search.charm === NO_CHARM ? "" : search.charm,
});

/** The address for `filters`, leaving out each filter that shows every value. */
export const searchFromFilters = (filters: ChangeFilters): ChangesSearch => ({
  ...(filters.hob === null ? {} : { hob: filters.hob }),
  ...(filters.actor === null ? {} : { by: filters.actor }),
  ...(filters.charm === null ? {} : { charm: filters.charm === "" ? NO_CHARM : filters.charm }),
});

const charmOf = (change: HobChange): string => change.origin?.charm ?? "";

export const matchesFilters = (change: HobChange, filters: ChangeFilters): boolean =>
  (filters.hob === null || change.hobId === filters.hob) &&
  (filters.actor === null || (hobBehind(change.actor) ?? "you") === filters.actor) &&
  (filters.charm === null || charmOf(change) === filters.charm);

/** The values each filter can take among `changes`, each once, in the order first met. */
export const filterChoices = (changes: ReadonlyArray<HobChange>) => {
  const hobs = new Set<AgentId>();
  const actors = new Set<"you" | AgentId>();
  const charms = new Set<string>();
  for (const change of changes) {
    hobs.add(change.hobId);
    actors.add(hobBehind(change.actor) ?? "you");
    charms.add(charmOf(change));
  }
  return { hobs: [...hobs], actors: [...actors], charms: [...charms] };
};

/**
 * The hob behind a hob's newest change, for the note on its Home tile, while you have not opened its
 * profile since (`seen`, an ISO time); null when the newest change was yours alone or you saw it.
 */
export const changedByNote = (
  hobId: AgentId,
  changes: ReadonlyArray<HobChange>,
  seen: string | undefined,
): AgentId | null => {
  const newest = changes.find((change) => change.hobId === hobId);
  if (newest === undefined || (seen !== undefined && newest.at <= seen)) return null;
  return newest.actor._tag === "Hob" ? newest.actor.hobId : null;
};
