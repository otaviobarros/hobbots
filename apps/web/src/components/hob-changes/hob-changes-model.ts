import {
  type Agent,
  type AgentId,
  type AnyOperation,
  configurationFields,
  type HobChange,
  heldCharms,
  hobAnswers,
  hobBehind,
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

/** Each field the History shows, in the profile's order, as text. */
const FIELDS: ReadonlyArray<readonly [FieldDiff["key"], (config: Config) => string, boolean]> = [
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
  ["rules", rulesText, true],
  ["signCommits", (c) => (c.policy.signCommits === true ? values.yes : values.no), false],
];

/**
 * What a version changed, field by field, against the version before it. The first version, which
 * the hob was summoned with, lists every field it set as added.
 */
export const fieldDiffs = (change: VersionChange): ReadonlyArray<FieldDiff> => {
  const after = configurationFields(change.config);
  const before = change.previous === null ? null : configurationFields(change.previous);
  return FIELDS.flatMap(([key, text, lines]) => {
    const now = text(after);
    const then = before === null ? "" : text(before);
    if (now === then) return [];
    return [{ key, label: messages.fields[key], before: then, after: now, lines }];
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
