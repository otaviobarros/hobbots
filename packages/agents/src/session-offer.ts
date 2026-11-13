import {
  type AgentId,
  type AnyOperation,
  GIT_INIT_TOOL,
  holdsCharm,
  MEMORY_SAVE_TOOL,
  MEMORY_SEARCH_TOOL,
  openTools,
  type PolicyDecision,
  type PolicyOperation,
  READ_HOB_TOOL,
  SKILL_FEEDBACK_TOOL,
  SKILL_PROPOSE_TOOL,
  SKILL_REQUEST_TOOL,
  SKILL_SEARCH_TOOL,
  WEB_FETCH_TOOL,
} from "@hobbots/domain";
import { Effect, Option } from "effect";
import { BUILT_IN_HUB_TOOLS, type Charm, Charms, closedOutsideChats } from "./charms.ts";
import type { ToolAccess } from "./runtime.ts";
import { operationDecision } from "./tools.ts";

/**
 * What a member's session outside any chat is offered, in words a lead acts on (#1348): each tool
 * with its answer, and each tool it is not offered with why. `delegate_task` and `check_delegation`
 * describe the offer the session itself is built from, so the two never differ.
 */

/** A tool's answer: Allow, Ask or Never, or null when each call is decided on what it targets. */
export type ToolAnswer = "allow" | "ask" | "never" | null;

/** A tool the session is offered, who offers it, and its answer. */
export interface OfferedTool {
  readonly tool: string;
  readonly from: string;
  readonly answer: ToolAnswer;
}

/**
 * Why the session is not offered a tool: its answer is Never, the hob does not hold the Charm, the
 * Charm is not connected, the Charm offers its writes only in chats, the session has no folder or
 * cannot read files so its turns are chat-only, or commands are closed by the file answers they need.
 */
export type DropReason = "never" | "not-granted" | "not-connected" | "chats-only" | "chat-only" | "commands-closed";

export interface DroppedTool {
  readonly tool: string;
  readonly from: string;
  readonly reason: DropReason;
}

export interface SessionToolOffer {
  readonly tools: ReadonlyArray<OfferedTool>;
  readonly dropped: ReadonlyArray<DroppedTool>;
}

/** Who offers the runtime's own file and command tools, as the offer names it. */
export const RUNTIME_TOOLS_OWNER = "the runtime";

/**
 * The operation each built-in hub tool is decided as, which is its answer, and under Never keeps it
 * from being offered (ADR 014). A built-in tool without one here is decided by no policy, as the
 * Task and Chapter tools are, so it is Allow.
 */
const BUILT_IN_OPERATIONS: Readonly<Record<string, PolicyOperation>> = {
  [GIT_INIT_TOOL]: "local-git",
  [MEMORY_SEARCH_TOOL]: "search-memory",
  [MEMORY_SAVE_TOOL]: "save-memory",
  [SKILL_SEARCH_TOOL]: "search-skills",
  [SKILL_REQUEST_TOOL]: "request-skill",
  [SKILL_PROPOSE_TOOL]: "propose-skill",
  [SKILL_FEEDBACK_TOOL]: "skill-feedback",
  [READ_HOB_TOOL]: "read-hobs",
  [WEB_FETCH_TOOL]: "use-web",
};

/** Who offers each built-in hub tool. */
const OWNERS = new Map(BUILT_IN_HUB_TOOLS.flatMap(({ owner, names }) => names.map((name) => [name, owner] as const)));

const answerOf = (decision: PolicyDecision): ToolAnswer => (decision === "deny" ? "never" : decision);

/** The runtime's own tools under `access`, offered or not, as `toolTurn` gives them a session. */
const runtimeTools = (access: ToolAccess | null, decide: (operation: AnyOperation) => PolicyDecision) => {
  const open = openTools(decide);
  const chatOnly = access === null || access.folders.length === 0 || !open.read;
  const commandOperation: PolicyOperation = decide("run-commands") === "deny" ? "local-git" : "run-commands";
  const entries: ReadonlyArray<readonly [string, boolean, PolicyOperation, DropReason]> = [
    ["file reads", open.read, "read-files", "never"],
    ["file edits", open.edit, "edit-files", "never"],
    [
      open.commandsReadOnly ? "read-only commands" : "commands",
      open.commands,
      commandOperation,
      decide("run-commands") === "deny" && decide("local-git") === "deny" ? "never" : "commands-closed",
    ],
  ];
  const tools: Array<OfferedTool> = [];
  const dropped: Array<DroppedTool> = [];
  for (const [tool, on, operation, closed] of entries) {
    if (on && !chatOnly) tools.push({ tool, from: RUNTIME_TOOLS_OWNER, answer: answerOf(decide(operation)) });
    else dropped.push({ tool, from: RUNTIME_TOOLS_OWNER, reason: chatOnly && on ? "chat-only" : closed });
  }
  return { tools, dropped };
};

/** Why a Charm's tool is not offered, when it is not. */
const charmDrop = (
  charm: Charm,
  tool: Charm["tools"][number],
  state: { readonly held: boolean; readonly connected: boolean },
  decide: (operation: AnyOperation) => PolicyDecision,
): DropReason | null => {
  if (!state.held) return "not-granted";
  if (!state.connected) return "not-connected";
  return closedOutsideChats(charm, tool, decide);
};

/**
 * Why a built-in hub tool is not offered, when its own rule closes it: its answer is Never, or, for
 * `git_init`, Edit files is Never or the session has no folder to make a repository in (ADR 014).
 */
const builtInDrop = (
  name: string,
  operation: PolicyOperation,
  access: ToolAccess | null,
  decide: (operation: AnyOperation) => PolicyDecision,
): ReadonlyArray<DroppedTool> => {
  const from = OWNERS.get(name) ?? "Hobbots";
  if (decide(operation) === "deny") return [{ tool: name, from, reason: "never" }];
  if (name !== GIT_INIT_TOOL) return [];
  if (!openTools(decide).gitInit) return [{ tool: name, from, reason: "never" }];
  return (access?.folders.length ?? 0) === 0 ? [{ tool: name, from, reason: "chat-only" }] : [];
};

/**
 * Describes the offer of a session outside any chat for `agentId` under `access`, the hub tools
 * named in `offered` being those the session's offer holds. Each offered tool is given its answer;
 * each tool the hub has that the session lacks is named with why: a Charm's, or a built-in hub
 * tool whose answer is Never. A built-in tool missing for any other reason, such as a service the
 * hub does not run, is not one the session could have, so it is left out.
 */
export const describeSessionOffer = Effect.gen(function* () {
  const registry = yield* Effect.serviceOption(Charms);
  const charms = Option.isSome(registry) ? registry.value.charms : [];
  const charmOf = new Map(charms.flatMap((charm) => charm.tools.map((tool) => [tool.name, { charm, tool }] as const)));
  /** An offered tool, with who offers it and its answer: a Charm tool with no operation decides each call. */
  const offeredTool = (name: string, decide: (operation: AnyOperation) => PolicyDecision): OfferedTool => {
    const charm = charmOf.get(name);
    if (charm !== undefined) {
      const { operation } = charm.tool;
      return {
        tool: name,
        from: `the ${charm.charm.name} Charm`,
        answer: operation === undefined ? null : answerOf(decide(operation)),
      };
    }
    const operation = BUILT_IN_OPERATIONS[name];
    return {
      tool: name,
      from: OWNERS.get(name) ?? "Hobbots",
      answer: operation === undefined ? "allow" : answerOf(decide(operation)),
    };
  };
  /** The tools of `charm` the session is not offered, with why. */
  const charmDrops = (
    charm: Charm,
    input: { readonly agentId: AgentId; readonly access: ToolAccess | null },
    offered: ReadonlySet<string>,
    decide: (operation: AnyOperation) => PolicyDecision,
  ) =>
    Effect.gen(function* () {
      const held = input.access !== null && holdsCharm(input.access.policy.hob, charm.declaration.id);
      const run = charm.connected(input.agentId);
      const connected = held
        ? yield* charm.context === undefined ? run : Effect.provideContext(run, charm.context)
        : false;
      return charm.tools.flatMap((tool): ReadonlyArray<DroppedTool> => {
        const reason = offered.has(tool.name) ? null : charmDrop(charm, tool, { held, connected }, decide);
        return reason === null ? [] : [{ tool: tool.name, from: `the ${charm.name} Charm`, reason }];
      });
    });
  return (input: {
    readonly agentId: AgentId;
    readonly access: ToolAccess | null;
    readonly offered: ReadonlyArray<string>;
  }): Effect.Effect<SessionToolOffer> =>
    Effect.gen(function* () {
      const { access } = input;
      const decide = (operation: AnyOperation): PolicyDecision =>
        access === null ? "deny" : operationDecision(access.policy, operation);
      const runtime = runtimeTools(access, decide);
      const offered = new Set(input.offered);
      const charmsDropped = yield* Effect.forEach(charms, (charm) => charmDrops(charm, input, offered, decide));
      const builtInsDropped = Object.entries(BUILT_IN_OPERATIONS).flatMap(([name, operation]) =>
        offered.has(name) ? [] : builtInDrop(name, operation, access, decide),
      );
      return {
        tools: [...runtime.tools, ...input.offered.map((name) => offeredTool(name, decide))],
        dropped: [...runtime.dropped, ...charmsDropped.flat(), ...builtInsDropped],
      };
    });
});
