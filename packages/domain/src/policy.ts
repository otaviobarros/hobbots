import { Schema, SchemaTransformation } from "effect";
import type { SafetyPreset } from "./setup.ts";

/**
 * The tool policy of ADR 014: the operations a hob's tool calls are normalized into, the answer a
 * preset gives each, and the per-hob configuration that can only narrow it. The policy engine in
 * `@hobbots/permissions` decides calls with these; this module holds only the shared shapes.
 */

/**
 * The built-in operations: every runtime tool call, sandbox network request and built-in hub tool
 * call becomes one of these. A Charm's operations are declared by the Charm (`CharmOperation`).
 */
export const PolicyOperation = Schema.Literals([
  "read-files",
  "edit-files",
  "delete-files",
  "run-commands",
  "local-git",
  "push",
  "use-web",
  "outside-folders",
  "search-memory",
  "save-memory",
  "search-skills",
  "request-skill",
  "propose-skill",
  "skill-feedback",
  "read-hobs",
  "search-web",
]);
export type PolicyOperation = typeof PolicyOperation.Type;

export const POLICY_OPERATIONS: ReadonlyArray<PolicyOperation> = PolicyOperation.literals;

/** The Memory group (ADR 028): `memory_search` and `memory_save` to the hob's own memory. */
export const MemoryOperation = Schema.Literals(["search-memory", "save-memory"]);
export type MemoryOperation = typeof MemoryOperation.Type;

/**
 * The Skills group (ADR 029): `skill_search`, `skill_request`, `skill_propose` and `skill_feedback`.
 * A proposal always waits for your review whatever the answer here, which decides only whether the
 * hob may make the call; a request for a skill already in the library follows the preset.
 */
export const SkillOperation = Schema.Literals(["search-skills", "request-skill", "propose-skill", "skill-feedback"]);
export type SkillOperation = typeof SkillOperation.Type;

/**
 * The Directory group (ADR 032): `read-hobs`, shown as Read other hobs. Allow gives a turn the
 * roster of the other visible hobs and offers `read_hob`; Ask leaves the roster out and asks on each
 * `read_hob` call; Never offers neither.
 */
export const DirectoryOperation = Schema.Literals(["read-hobs"]);
export type DirectoryOperation = typeof DirectoryOperation.Type;

/**
 * Search the web (ADR 036), in the Web group beside Use the web: the runtime's own search, run on its
 * provider's servers. Allow offers it for the turn; Never offers none. It has no Ask, since Codex's
 * search runs inside the model's turn and cannot pause, and the answer must act the same on every
 * runtime.
 */
export const SearchOperation = Schema.Literals(["search-web"]);
export type SearchOperation = typeof SearchOperation.Type;

/**
 * The built-in operations that take Allow or Never only (ADR 036). An override of Ask for one is
 * refused when saved, and a turn is offered the operation only when its answer is Allow.
 */
export const ALLOW_OR_NEVER_OPERATIONS: ReadonlyArray<PolicyOperation> = ["search-web"];

/** Allow proceeds, Ask pauses the turn for an approval, Deny refuses (the UI says Never). */
export const PolicyDecision = Schema.Literals(["allow", "ask", "deny"]);
export type PolicyDecision = typeof PolicyDecision.Type;

const NARROWNESS: Record<PolicyDecision, number> = { allow: 0, ask: 1, deny: 2 };

/** Whether `override` is at least as narrow as `preset`, so applying it cannot widen authority. */
export const isNarrowerOrEqual = (override: PolicyDecision, preset: PolicyDecision): boolean =>
  NARROWNESS[override] >= NARROWNESS[preset];

/** The narrowest of the answers: the intersection of every layer that has a say. */
export const narrowest = (first: PolicyDecision, ...rest: ReadonlyArray<PolicyDecision>): PolicyDecision =>
  rest.reduce((current, next) => (NARROWNESS[next] > NARROWNESS[current] ? next : current), first);

/** The preset table of ADR 014. */
export const PRESET_DECISIONS: Record<SafetyPreset, Record<PolicyOperation, PolicyDecision>> = {
  careful: {
    "read-files": "allow",
    "edit-files": "ask",
    "delete-files": "ask",
    "run-commands": "ask",
    "local-git": "ask",
    push: "ask",
    "use-web": "ask",
    "outside-folders": "deny",
    "search-memory": "allow",
    "save-memory": "allow",
    "search-skills": "allow",
    "request-skill": "ask",
    "propose-skill": "allow",
    "skill-feedback": "allow",
    "read-hobs": "allow",
    "search-web": "allow",
  },
  balanced: {
    "read-files": "allow",
    "edit-files": "allow",
    "delete-files": "ask",
    "run-commands": "allow",
    "local-git": "allow",
    push: "ask",
    "use-web": "allow",
    "outside-folders": "deny",
    "search-memory": "allow",
    "save-memory": "allow",
    "search-skills": "allow",
    "request-skill": "ask",
    "propose-skill": "allow",
    "skill-feedback": "allow",
    "read-hobs": "allow",
    "search-web": "allow",
  },
  trusting: {
    "read-files": "allow",
    "edit-files": "allow",
    "delete-files": "allow",
    "run-commands": "allow",
    "local-git": "allow",
    push: "allow",
    "use-web": "allow",
    "outside-folders": "deny",
    "search-memory": "allow",
    "save-memory": "allow",
    "search-skills": "allow",
    "request-skill": "allow",
    "propose-skill": "allow",
    "skill-feedback": "allow",
    "read-hobs": "allow",
    "search-web": "allow",
  },
};

/**
 * A Charm's id, such as `github`: lowercase words joined by hyphens. Its operations' ids start with
 * it (ADR 031).
 */
export const CharmId = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/));
export type CharmId = typeof CharmId.Type;

/** A Charm operation's id, `<charm>.<operation>`, such as `github.comment`. */
export const CharmOperationId = Schema.TemplateLiteral([Schema.String, ".", Schema.String]).check(
  Schema.isPattern(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/),
);
export type CharmOperationId = typeof CharmOperationId.Type;

/** Any operation a call is decided as: a built-in one, or one a Charm declares. */
export const AnyOperation = Schema.Union([PolicyOperation, CharmOperationId]);
export type AnyOperation = typeof AnyOperation.Type;

/** Whether an operation is a Charm's rather than a built-in one. */
export const isCharmOperation = (operation: AnyOperation): operation is CharmOperationId => operation.includes(".");

/** The Charm a Charm operation belongs to. */
export const charmOfOperation = (operation: CharmOperationId): CharmId => operation.slice(0, operation.indexOf("."));

/**
 * The names the GitHub Charm's operations had before they were declared by the Charm (ADR 031).
 * Only decoding uses them, so overrides, approvals, grants and events stored before the change read
 * as they always meant.
 */
const LEGACY_OPERATIONS: Readonly<Record<string, CharmOperationId>> = {
  "read-github": "github.read",
  "open-pull-request": "github.open-pull-request",
  "comment-github": "github.comment",
};

/** An operation's current name, for one stored before ADR 031. */
export const currentOperationName = (name: string): string => LEGACY_OPERATIONS[name] ?? name;

/** An operation as stored or journaled: a name from before ADR 031 decodes as the operation it became. */
export const StoredOperation = Schema.String.pipe(
  Schema.decodeTo(
    AnyOperation,
    SchemaTransformation.transform({
      decode: (name: string) => currentOperationName(name) as AnyOperation,
      encode: (operation: AnyOperation): string => operation,
    }),
  ),
);

/**
 * An operation a Charm declares (ADR 031). `words` name it in the hub's reasons, such as "opening
 * pull requests"; the UI's own words are keyed by its id. `site` names the request's site fields a
 * grant names, such as the repository and base branch, never free text. An operation that declares
 * no site, or is `onceOnly`, is approved once only. `actsAsIdentity` marks an operation the Charm
 * performs as an identity, such as the user's GitHub account or the hob's own app, so a grant for it
 * belongs to that identity (ADR 022).
 */
export interface CharmOperation {
  readonly id: CharmOperationId;
  readonly words: string;
  readonly presets: Readonly<Record<SafetyPreset, PolicyDecision>>;
  readonly site: ReadonlyArray<string>;
  readonly onceOnly: boolean;
  readonly actsAsIdentity: boolean;
}

/**
 * What a Charm declares to the policy: its operations, and the built-in operations it takes over,
 * whose calls it makes as its identity too, such as Push for the GitHub Charm (ADR 031).
 */
export interface CharmDeclaration {
  readonly id: CharmId;
  readonly operations: ReadonlyArray<CharmOperation>;
  readonly takesOver: ReadonlyArray<PolicyOperation>;
}

/** Every operation the Charms declare. */
export const declaredOperations = (charms: ReadonlyArray<CharmDeclaration>): ReadonlyArray<CharmOperation> =>
  charms.flatMap((charm) => charm.operations);

/**
 * The preset's answer for any operation. A Charm operation nothing declares is never allowed, so a
 * call no Charm stands behind stays closed.
 */
export const presetDecision = (
  preset: SafetyPreset,
  operation: AnyOperation,
  declared: ReadonlyArray<CharmOperation>,
): PolicyDecision =>
  isCharmOperation(operation)
    ? (declared.find((each) => each.id === operation)?.presets[preset] ?? "deny")
    : PRESET_DECISIONS[preset][operation];

/**
 * Rules Hobbots recognizes and decides but a permitted command could always perform another way
 * (ADR 014). Push is also checked where Run commands and Use the web are both Allow, since a command
 * can push to a remote that needs no credentials, and every rule is checked for an unsandboxed hob.
 * Each verdict's `enforcement` says which applies.
 */
export const CHECKED_OPERATIONS: ReadonlyArray<PolicyOperation> = ["delete-files"];

/** Whether the runtime runs inside Hobbots' sandbox, was let out of it, or the sandbox cannot start. */
export const SandboxState = Schema.Literals(["on", "off", "unavailable"]);
export type SandboxState = typeof SandboxState.Type;

/**
 * Whether a rule is enforced by a runtime or OS boundary or only checked by Hobbots (ADR 014), given
 * each operation's answer. Push is checked where commands and the web are both allowed in the
 * sandbox, since a command can then push to a remote that needs no credentials, bypassing the Push
 * Charm. Local Git is checked where its answer is narrower than Run commands, since any permitted
 * command can run Git another way (`sh -c 'git commit'`). Every rule is checked for a hob let out of
 * the sandbox.
 */
export const ruleEnforcement = (
  operation: PolicyOperation,
  answer: (operation: PolicyOperation) => PolicyDecision,
  sandbox: SandboxState,
): "enforced" | "checked" => {
  if (sandbox === "off" || CHECKED_OPERATIONS.includes(operation)) return "checked";
  if (operation === "local-git") {
    const git = answer("local-git");
    const commands = answer("run-commands");
    return git !== commands && narrowest(git, commands) === git ? "checked" : "enforced";
  }
  const bypass = sandbox === "on" && answer("run-commands") === "allow" && answer("use-web") === "allow";
  return operation === "push" && bypass ? "checked" : "enforced";
};

/**
 * Which of a hob's tools its answers open (ADR 014), whatever the runtime calls them: file reads,
 * file edits, and commands. A command reads and writes the folders without a call per file, so
 * commands, Git's included, need Read files Allow, and Edit files Allow or Never. With Edit files
 * Never they are read-only: the sandbox closes the folders, `.git` included, to every write of the
 * turn. With Edit files Ask they stay closed, since a command would write without asking. A runtime
 * also needs its sandbox to offer them. `git_init` is decided as Local Git and Edit files.
 */
export const openTools = (decide: (operation: PolicyOperation) => PolicyDecision) => {
  const open = (operation: PolicyOperation) => decide(operation) !== "deny";
  const edit = decide("edit-files");
  const commands = (open("run-commands") || open("local-git")) && decide("read-files") === "allow" && edit !== "ask";
  return {
    read: open("read-files"),
    edit: edit !== "deny",
    commands,
    commandsReadOnly: commands && edit === "deny",
    gitInit: open("local-git") && edit !== "deny",
  };
};

/** Per-hob answers. Each may only narrow the preset; a widening needs a separately recorded user grant. */
export const PolicyOverrides = Schema.Struct({
  "read-files": Schema.optionalKey(PolicyDecision),
  "edit-files": Schema.optionalKey(PolicyDecision),
  "delete-files": Schema.optionalKey(PolicyDecision),
  "run-commands": Schema.optionalKey(PolicyDecision),
  "local-git": Schema.optionalKey(PolicyDecision),
  push: Schema.optionalKey(PolicyDecision),
  "use-web": Schema.optionalKey(PolicyDecision),
  "outside-folders": Schema.optionalKey(PolicyDecision),
  "search-memory": Schema.optionalKey(PolicyDecision),
  "save-memory": Schema.optionalKey(PolicyDecision),
  "search-skills": Schema.optionalKey(PolicyDecision),
  "request-skill": Schema.optionalKey(PolicyDecision),
  "propose-skill": Schema.optionalKey(PolicyDecision),
  "skill-feedback": Schema.optionalKey(PolicyDecision),
  "read-hobs": Schema.optionalKey(PolicyDecision),
  "search-web": Schema.optionalKey(PolicyDecision),
});
export type PolicyOverrides = typeof PolicyOverrides.Type;

/** Per-hob answers for Charm operations, keyed by their id. Each may only narrow the declared preset answer. */
export const CharmOverrides = Schema.Record(CharmOperationId, PolicyDecision);
export type CharmOverrides = typeof CharmOverrides.Type;

/**
 * One layer's answers for any operation: the built-in ones by name and the Charm ones by id. A
 * restriction from a delegation is one of these (ADR 018), so a lead can narrow a member's Charm
 * operations too.
 */
export const PolicyLayer = Schema.StructWithRest(PolicyOverrides, [CharmOverrides]);
export type PolicyLayer = typeof PolicyLayer.Type;

/** Each answer under its current operation name, for answers stored before ADR 031. */
const renamedAnswers = (answers: Readonly<Record<string, PolicyDecision>>): Record<string, PolicyDecision> =>
  Object.fromEntries(Object.entries(answers).map(([name, decision]) => [currentOperationName(name), decision]));

/** A layer as stored or journaled: an operation named as before ADR 031 decodes under its current id. */
export const StoredPolicyLayer = Schema.Record(Schema.String, PolicyDecision).pipe(
  Schema.decodeTo(
    PolicyLayer,
    SchemaTransformation.transform({
      decode: renamedAnswers,
      encode: (layer: Readonly<Record<string, PolicyDecision>>) => layer,
    }),
  ),
);

/**
 * Which hobs a hob holding the Summoning Charm may manage (ADR 034): the hobs it summoned, on by
 * default; a list of hobs you pick, empty by default; and itself, off by default. A retired hob is
 * outside every scope. Only you change it.
 */
export const SummoningScope = Schema.Struct({
  summoned: Schema.Boolean,
  /** The ids of the hobs you picked. */
  hobs: Schema.Array(Schema.String),
  self: Schema.Boolean,
});
export type SummoningScope = typeof SummoningScope.Type;

/** The scope the Summoning Charm's grant holds until you change it (ADR 034). */
export const DEFAULT_SUMMONING_SCOPE: SummoningScope = { summoned: true, hobs: [], self: false };

/**
 * What a hob holds of the Charms (ADR 031): `granted`, the ids of the Charms you gave it, and its
 * overrides for their operations, keyed by id. Without `granted`, the hob holds the Charms every hob
 * starts with (`DEFAULT_HOB_CHARMS`). `summoning` is the Summoning Charm's scope, beside its
 * overrides, and `withheld` the Charms you gave every hob that you took away from this one (ADR 034).
 */
export const HobCharms = Schema.Struct({
  granted: Schema.optionalKey(Schema.Array(CharmId)),
  overrides: Schema.optionalKey(CharmOverrides),
  summoning: Schema.optionalKey(SummoningScope),
  withheld: Schema.optionalKey(Schema.Array(CharmId)),
});
export type HobCharms = typeof HobCharms.Type;

/**
 * A hob's own policy configuration. Folders are stored canonical. `hiddenSharedFolders` hides
 * shared folders from this hob only; a hob cannot add a folder to itself. `signCommits` lets the
 * hob's commands sign Git commits with the user's 1Password SSH key, which opens 1Password's SSH
 * agent to them: the agent cannot be limited to signing, so it also lets them log in over SSH with
 * the user's keys. Off unless the user turns it on. `charms` holds the Charms the hob is granted and
 * its overrides for their operations (ADR 031); without a Charm, the hob is offered none of its
 * actions. The built-in `overrides` stay a closed record.
 */
const HobPolicyFields = {
  ownFolders: Schema.Array(Schema.String),
  hiddenSharedFolders: Schema.Array(Schema.String),
  overrides: PolicyOverrides,
  signCommits: Schema.optionalKey(Schema.Boolean),
  charms: Schema.optionalKey(HobCharms),
};
const CurrentHobPolicy = Schema.Struct(HobPolicyFields);
type CurrentHobPolicy = typeof CurrentHobPolicy.Type;

/**
 * A policy as stored or journaled, in its current shape: a Charm operation's override goes to
 * `charms`, under its current id when it was stored before ADR 031 under its old name, and the
 * `githubCharm` flag of a policy saved before the Charm-id grant becomes the set it meant: off holds
 * no Charm, on the GitHub Charm, as every hob started with it.
 */
const currentPolicy = (stored: StoredHobPolicy): CurrentHobPolicy => {
  const { overrides, charms, githubCharm, ...rest } = stored;
  const renamed = renamedAnswers(overrides);
  const builtIn = Object.fromEntries(Object.entries(renamed).filter(([name]) => !name.includes(".")));
  const charm = {
    ...Object.fromEntries(Object.entries(renamed).filter(([name]) => name.includes("."))),
    ...charms?.overrides,
  };
  const granted = charms?.granted ?? (githubCharm === false ? [] : undefined);
  const held: HobCharms = {
    ...(granted === undefined ? {} : { granted }),
    ...(Object.keys(charm).length === 0 ? {} : { overrides: charm as CharmOverrides }),
    ...(charms?.summoning === undefined ? {} : { summoning: charms.summoning }),
    ...(charms?.withheld === undefined || charms.withheld.length === 0 ? {} : { withheld: charms.withheld }),
  };
  return { ...rest, overrides: builtIn, ...(Object.keys(held).length === 0 ? {} : { charms: held }) };
};

const StoredHobPolicyFields = {
  ...HobPolicyFields,
  overrides: Schema.Record(Schema.String, PolicyDecision),
  /** The GitHub Charm's grant before ADR 031 made it a Charm id in `charms.granted`. */
  githubCharm: Schema.optionalKey(Schema.Boolean),
};
type StoredHobPolicy = Schema.Struct<typeof StoredHobPolicyFields>["Type"];

export const HobPolicy = Schema.Struct(StoredHobPolicyFields).pipe(
  Schema.decodeTo(
    CurrentHobPolicy,
    SchemaTransformation.transform({
      decode: currentPolicy,
      encode: (policy: CurrentHobPolicy): StoredHobPolicy => policy,
    }),
  ),
);
export type HobPolicy = typeof HobPolicy.Type;

/** The hob's own answers for every operation: its built-in overrides and its Charm overrides. */
export const hobAnswers = (hob: HobPolicy): PolicyLayer => ({ ...hob.charms?.overrides, ...hob.overrides });

/**
 * The Charms a hob holds when you never chose them: the GitHub Charm, which every hob has had unless
 * you took it away (ADR 020).
 */
export const DEFAULT_HOB_CHARMS: ReadonlyArray<CharmId> = ["github"];

/** The ids of the Charms a hob holds (ADR 031), each once. */
export const heldCharms = (hob: HobPolicy): ReadonlyArray<CharmId> => [
  ...new Set(hob.charms?.granted ?? DEFAULT_HOB_CHARMS),
];

/** Whether a hob holds the Charm `charm`. */
export const holdsCharm = (hob: HobPolicy, charm: CharmId): boolean => heldCharms(hob).includes(charm);

/** A new hob's policy: no folders of its own, no overrides, and the Charms every hob starts with. */
export const EMPTY_HOB_POLICY: HobPolicy = {
  ownFolders: [],
  hiddenSharedFolders: [],
  overrides: {},
  charms: { granted: DEFAULT_HOB_CHARMS },
};

/**
 * The answer a hob gets for one operation, built-in or declared by a Charm in `declared`: the
 * narrower of the preset's and the hob's own, so an override stored under one preset never widens a
 * stricter preset picked later.
 */
export const effectiveDecision = (
  preset: SafetyPreset,
  answers: PolicyLayer,
  operation: AnyOperation,
  declared: ReadonlyArray<CharmOperation> = [],
): PolicyDecision => {
  const answer = presetDecision(preset, operation, declared);
  const override = answers[operation];
  return override === undefined ? answer : narrowest(answer, override);
};

/**
 * One operation's answer for a hob: the decision it gets, and whether the hob's own override set it
 * rather than the preset. An override the preset is already narrower than decides nothing, so it is
 * not marked.
 */
export interface EffectiveAnswer {
  readonly operation: AnyOperation;
  readonly decision: PolicyDecision;
  readonly override: boolean;
}

/**
 * A hob's answers under `preset`: each built-in operation, then each of `declared`, in order, after
 * the hob's overrides. The Permissions tab and the hob's public card (ADR 032) both read these.
 */
export const effectiveAnswers = (
  preset: SafetyPreset,
  policy: HobPolicy,
  declared: ReadonlyArray<CharmOperation>,
): ReadonlyArray<EffectiveAnswer> => {
  const answers = hobAnswers(policy);
  return [...POLICY_OPERATIONS, ...declared.map((operation) => operation.id)].map((operation) => {
    const decision = effectiveDecision(preset, answers, operation, declared);
    return { operation, decision, override: answers[operation] !== undefined && answers[operation] === decision };
  });
};
