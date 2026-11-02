import { Schema } from "effect";
import type { SafetyPreset } from "./setup.ts";

/**
 * The tool policy of ADR 014: the operations a hob's tool calls are normalized into, the answer a
 * preset gives each, and the per-hob configuration that can only narrow it. The policy engine in
 * `@hobbots/permissions` decides calls with these; this module holds only the shared shapes.
 */

/** The MVP operations. Every runtime tool call and sandbox network request becomes one of these. */
export const PolicyOperation = Schema.Literals([
  "read-files",
  "edit-files",
  "delete-files",
  "run-commands",
  "local-git",
  "push",
  "use-web",
  "read-github",
  "open-pull-request",
  "comment-github",
  "outside-folders",
]);
export type PolicyOperation = typeof PolicyOperation.Type;

export const POLICY_OPERATIONS: ReadonlyArray<PolicyOperation> = PolicyOperation.literals;

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
    "read-github": "allow",
    "open-pull-request": "ask",
    "comment-github": "ask",
    "outside-folders": "deny",
  },
  balanced: {
    "read-files": "allow",
    "edit-files": "allow",
    "delete-files": "ask",
    "run-commands": "allow",
    "local-git": "allow",
    push: "ask",
    "use-web": "allow",
    "read-github": "allow",
    "open-pull-request": "ask",
    "comment-github": "ask",
    "outside-folders": "deny",
  },
  trusting: {
    "read-files": "allow",
    "edit-files": "allow",
    "delete-files": "allow",
    "run-commands": "allow",
    "local-git": "allow",
    push: "allow",
    "use-web": "allow",
    "read-github": "allow",
    "open-pull-request": "allow",
    "comment-github": "allow",
    "outside-folders": "deny",
  },
};

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

/** Per-hob answers. Each may only narrow the preset; a widening needs a separately recorded user grant. */
export const PolicyOverrides = Schema.Struct({
  "read-files": Schema.optionalKey(PolicyDecision),
  "edit-files": Schema.optionalKey(PolicyDecision),
  "delete-files": Schema.optionalKey(PolicyDecision),
  "run-commands": Schema.optionalKey(PolicyDecision),
  "local-git": Schema.optionalKey(PolicyDecision),
  push: Schema.optionalKey(PolicyDecision),
  "use-web": Schema.optionalKey(PolicyDecision),
  "read-github": Schema.optionalKey(PolicyDecision),
  "open-pull-request": Schema.optionalKey(PolicyDecision),
  "comment-github": Schema.optionalKey(PolicyDecision),
  "outside-folders": Schema.optionalKey(PolicyDecision),
});
export type PolicyOverrides = typeof PolicyOverrides.Type;

/**
 * A hob's own policy configuration. Folders are stored canonical. `hiddenSharedFolders` hides
 * shared folders from this hob only; a hob cannot add a folder to itself. `signCommits` lets the
 * hob's commands sign Git commits with the user's 1Password SSH key, which opens 1Password's SSH
 * agent to them: the agent cannot be limited to signing, so it also lets them log in over SSH with
 * the user's keys. Off unless the user turns it on. `githubCharm` is the hob's grant of the GitHub Charm
 * (ADR 014, ADR 020): granted unless it is `false`, and without it the hob is offered none of the
 * Charm's actions.
 */
export const HobPolicy = Schema.Struct({
  ownFolders: Schema.Array(Schema.String),
  hiddenSharedFolders: Schema.Array(Schema.String),
  overrides: PolicyOverrides,
  signCommits: Schema.optionalKey(Schema.Boolean),
  githubCharm: Schema.optionalKey(Schema.Boolean),
});
export type HobPolicy = typeof HobPolicy.Type;

export const EMPTY_HOB_POLICY: HobPolicy = { ownFolders: [], hiddenSharedFolders: [], overrides: {} };
