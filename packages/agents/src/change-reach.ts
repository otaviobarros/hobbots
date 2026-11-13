import type { ChangeReach } from "@hobbots/api";
import {
  type AnyOperation,
  type CharmId,
  type CharmOperation,
  effectiveDecision,
  type HobPolicy,
  heldCharms,
  hobAnswers,
  isCharmOperation,
  openTools,
  type PolicyDecision,
  type PolicyOperation,
  RUNTIME_NAMES,
  type RuntimeKind,
  type SafetyPreset,
} from "@hobbots/domain";

/**
 * When a change to a hob applies (#1347). Every turn reads the hob's configuration and tools when
 * it starts, in a chat or a Task alike, so a change applies from the hob's next turn. A turn already
 * running keeps what it started with, unless the change takes something away: that stops it
 * (PE-008, ADR 031). Two kinds of session still miss a tool the change opens, and the change says so:
 * one outside any chat, for a Charm that offers its writes only in chats (ADR 038), and one a
 * runtime resumes with the hub tools it started with, as Codex does (#1245).
 */

/** The rule, as the hub and the app word it, after "<who> gets this". */
export const APPLIES_FROM_NEXT_TURN =
  "from its next turn, in a chat or a Task. A turn already running finishes the old way, unless this takes something away: then it stops.";

/** The rule for one hob, named `who`. */
export const whenItApplies = (who: string) => `${who} gets this ${APPLIES_FROM_NEXT_TURN}`;

/** What the reach of a change reads of a Charm the hub holds. */
export interface ReachCharm {
  readonly declaration: { readonly id: CharmId; readonly operations: ReadonlyArray<CharmOperation> };
  readonly name: string;
  readonly tools: ReadonlyArray<{ readonly effect: string; readonly operation?: AnyOperation | undefined }>;
  readonly writesOutsideChats?: boolean;
}

/** A hob's version, as the reach of a change compares two. */
export interface ReachHob {
  readonly policy: HobPolicy;
}

type Decide = (operation: PolicyOperation) => PolicyDecision;

/**
 * The built-in hub tools, by the operation that names them, with whether a turn under `decide` is
 * offered them: an operation answered Never offers none of its tools (ADR 014).
 */
const BUILT_IN_TOOL_GATES: ReadonlyArray<{
  readonly operation: PolicyOperation;
  readonly words: string;
  readonly offered: (decide: Decide) => boolean;
}> = [
  { operation: "local-git", words: "creating a Git repository", offered: (decide) => openTools(decide).gitInit },
  ...(
    [
      ["use-web", "reading web pages"],
      ["search-memory", "searching memory"],
      ["save-memory", "saving to memory"],
      ["search-skills", "searching skills"],
      ["request-skill", "asking for a skill"],
      ["propose-skill", "suggesting a skill"],
      ["skill-feedback", "reporting a skill problem"],
      ["read-hobs", "reading other hobs"],
    ] as const
  ).map(([operation, words]) => ({ operation, words, offered: (decide: Decide) => decide(operation) !== "deny" })),
];

const listFormat = new Intl.ListFormat("en", { type: "conjunction" });

const NONE: ChangeReach["newSessionsOnly"] = { runtimes: [], charms: [], operations: [], taskOperations: [] };

/** Whether nothing the change opens is kept from any of the hob's sessions. */
export const reachesEverySession = (reach: ChangeReach) =>
  reach.chatsOnly.length === 0 &&
  reach.newSessionsOnly.charms.length === 0 &&
  reach.newSessionsOnly.operations.length === 0 &&
  reach.newSessionsOnly.taskOperations.length === 0;

/**
 * What a change from `before` to `after` opens that some of the hob's sessions still do not get,
 * under the installation's `preset`, with the Charms the hub holds. `keepsTools` lists the runtimes,
 * among those the hob's sessions run on, that resume a session with the hub tools it started with.
 *
 * It follows how each session is offered tools: a chat is offered every tool of each Charm the hob
 * holds, a write under Never refused on its step; a session outside any chat is offered a Charm's
 * reads, and its writes only where the Charm offers them there and they are not Never (ADR 038); a
 * built-in hub tool is offered in either while its answer is not Never (ADR 014).
 */
export const changeReach = (input: {
  readonly before: ReachHob;
  readonly after: ReachHob;
  readonly preset: SafetyPreset;
  readonly charms: ReadonlyArray<ReachCharm>;
  readonly keepsTools: ReadonlyArray<RuntimeKind>;
}): ChangeReach => {
  const declared = input.charms.flatMap((charm) => charm.declaration.operations);
  const decide = (policy: HobPolicy) => (operation: AnyOperation) =>
    effectiveDecision(input.preset, hobAnswers(policy), operation, declared);
  const was = decide(input.before.policy);
  const is = decide(input.after.policy);
  const heldBefore = heldCharms(input.before.policy);
  const held = input.charms.filter((charm) => heldCharms(input.after.policy).includes(charm.declaration.id));
  const granted = held.filter((charm) => !heldBefore.includes(charm.declaration.id));
  const kept = held.filter((charm) => !granted.includes(charm));
  /** A write the change opens: one of a Charm granted under anything but Never, or one it took off Never. */
  const opensWrite = (tool: ReachCharm["tools"][number], fresh: boolean) =>
    tool.effect === "write" &&
    (tool.operation === undefined ? fresh : is(tool.operation) !== "deny" && (fresh || was(tool.operation) === "deny"));

  // A write is offered outside a chat only by a Charm that offers its writes there (ADR 038).
  const chatsOnly = held
    .filter((charm) => charm.writesOutsideChats !== true)
    .filter((charm) => charm.tools.some((tool) => opensWrite(tool, granted.includes(charm))))
    .map((charm) => charm.declaration.id);
  if (input.keepsTools.length === 0) return { chatsOnly, newSessionsOnly: NONE };

  const operations = BUILT_IN_TOOL_GATES.filter((gate) => gate.offered(is) && !gate.offered(was)).map(
    (gate) => gate.operation,
  );
  // A chat had a held Charm's writes already, Never or not; a Task gets one once it is off Never.
  const taskOperations = kept
    .filter((charm) => charm.writesOutsideChats === true)
    .flatMap((charm) => charm.tools.filter((tool) => opensWrite(tool, false)))
    .flatMap((tool) => (tool.operation === undefined ? [] : [tool.operation]));
  const newSessionsOnly = {
    runtimes: input.keepsTools,
    charms: granted.map((charm) => charm.declaration.id),
    operations,
    taskOperations: [...new Set(taskOperations)],
  };
  const any = newSessionsOnly.charms.length + operations.length + newSessionsOnly.taskOperations.length > 0;
  return { chatsOnly, newSessionsOnly: any ? newSessionsOnly : NONE };
};

/**
 * The sentences that name what a change to `hob` opens that some of its sessions still do not get,
 * and why, or none when it reaches every session.
 */
export const reachLines = (
  hob: { readonly name: string },
  reach: ChangeReach,
  charms: ReadonlyArray<ReachCharm>,
): ReadonlyArray<string> => {
  const nameOf = (id: CharmId) => charms.find((charm) => charm.declaration.id === id)?.name ?? id;
  const words = (operation: AnyOperation) =>
    isCharmOperation(operation)
      ? (charms.flatMap((charm) => charm.declaration.operations).find((each) => each.id === operation)?.words ??
        operation)
      : (BUILT_IN_TOOL_GATES.find((gate) => gate.operation === operation)?.words ?? operation);
  const { runtimes, charms: granted, operations, taskOperations } = reach.newSessionsOnly;
  const on = listFormat.format(runtimes.map((runtime) => RUNTIME_NAMES[runtime]));
  const everywhere = listFormat.format([
    ...granted.map((id) => `the ${nameOf(id)} Charm's tools`),
    ...(operations.length === 0 ? [] : [`the tools for ${listFormat.format(operations.map(words))}`]),
  ]);
  const inTasks = taskOperations.length === 0 ? "" : `the tools for ${listFormat.format(taskOperations.map(words))}`;
  return [
    ...reach.chatsOnly.map(
      (id) =>
        `In a Task, ${hob.name} is still not offered the ${nameOf(id)} Charm's writes: that Charm offers them only in chats.`,
    ),
    ...(everywhere === ""
      ? []
      : [
          `On ${on}, a chat or Task ${hob.name} already started keeps the tools it started with, so ${hob.name} gets ${everywhere} only in a chat or Task it starts after this.`,
        ]),
    ...(inTasks === ""
      ? []
      : [
          `On ${on}, a Task ${hob.name} already started keeps the tools it started with, so ${hob.name} gets ${inTasks} only in a Task it starts after this.`,
        ]),
  ];
};
