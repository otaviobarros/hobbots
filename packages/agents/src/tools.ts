import {
  type Agent,
  type AgentId,
  isNarrowerOrEqual,
  narrowest,
  POLICY_OPERATIONS,
  type PolicyDecision,
  type PolicyOperation,
  PRESET_DECISIONS,
} from "@hobbots/domain";
import { Context, Effect, Layer, Option } from "effect";
import type { TurnStart } from "./commit-identity.ts";
import type { HobbotsRepository } from "./repository.ts";
import type { HubCallStep, HubTool, HubToolAnswer, HubTools, ToolAccess, ToolPolicy } from "./runtime.ts";

/** The preset's answer for an operation, narrowed by the hob's overrides and every restriction. */
export const operationDecision = (
  context: Pick<ToolPolicy, "preset" | "hob" | "restrictions">,
  operation: PolicyOperation,
): PolicyDecision =>
  narrowest(
    PRESET_DECISIONS[context.preset][operation],
    ...[context.hob.overrides, ...context.restrictions].flatMap((layer) => layer[operation] ?? []),
  );

/**
 * The hub tools a turn is offered under `access`: each whose operation its policy does not answer
 * Never for, reached through `call`, or null when there is no access or no tool left.
 */
export const offeredHubTools = (
  access: ToolAccess | null,
  tools: ReadonlyArray<HubTool>,
  operationOf: (tool: string) => PolicyOperation,
  call: (name: string, input: unknown, step: HubCallStep | undefined) => Effect.Effect<HubToolAnswer>,
): HubTools | null => {
  if (access === null) return null;
  const open = tools.filter((tool) => operationDecision(access.policy, operationOf(tool.name)) !== "deny");
  return open.length === 0 ? null : { tools: open, call: (name, input, step) => call(name, input, step) };
};

/**
 * Which of a hob's tools its answers open (ADR 014), whatever the runtime calls them: file reads,
 * file edits, and commands. Since a command reads and writes the folders without a call per file,
 * commands, Git's included, are open only when Read files and Edit files are both Allow, and a
 * runtime also needs its sandbox to offer them. `git_init` is decided as Local Git and Edit files.
 */
export const openTools = (decide: (operation: PolicyOperation) => PolicyDecision) => {
  const open = (operation: PolicyOperation) => decide(operation) !== "deny";
  return {
    read: open("read-files"),
    edit: open("edit-files"),
    commands:
      (open("run-commands") || open("local-git")) &&
      decide("read-files") === "allow" &&
      decide("edit-files") === "allow",
    gitInit: open("local-git") && open("edit-files"),
  };
};

/**
 * Whether the hob's override or a restriction answers the operation with Ask or Never: an answer
 * someone gave on purpose, which no grant answers (ADR 015).
 */
export const explicitlyNarrowed = (
  context: Pick<ToolPolicy, "hob" | "restrictions">,
  operation: PolicyOperation,
): boolean =>
  [context.hob.overrides, ...context.restrictions].some((layer) => (layer[operation] ?? "allow") !== "allow");

/**
 * Whether `after` takes away anything `before` gave: a folder, the tools altogether, the user's
 * signing agent (`signCommits`), or an operation whose answer gets narrower. A turn granted `before`
 * must then stop, since its calls and commands already run under what it was given (PE-008).
 */
export const narrows = (before: ToolAccess | null, after: ToolAccess | null): boolean => {
  if (before === null) return false;
  if (after === null || after.policy.dataFolder !== before.policy.dataFolder) return true;
  if (before.folders.some((folder) => !after.folders.includes(folder))) return true;
  if (before.policy.hob.signCommits === true && after.policy.hob.signCommits !== true) return true;
  return POLICY_OPERATIONS.some((operation) => {
    const was = operationDecision(before.policy, operation);
    const is = operationDecision(after.policy, operation);
    return is !== was && isNarrowerOrEqual(is, was);
  });
};

/**
 * What a hob may do with tools on its next turn (ADR 014): the installation's preset and shared
 * folders, the hob's own policy and folders, and Hobbots' data folder, which stays closed. Read at
 * the start of every turn. A change applies from the next one, and a narrower one also stops the
 * turns already running (see `narrows`).
 */
export class HobTools extends Context.Service<
  HobTools,
  {
    /**
     * What `agent` may do with tools now. `turn` is given for a turn about to start: only then may
     * the hub put a question about it to you, such as who its commits are made as (#741).
     */
    readonly access: (agent: Agent, turn?: TurnStart) => Effect.Effect<ToolAccess | null>;
  }
>()("@hobbots/agents/HobTools") {
  /** Every turn chat-only, for hubs and tests that give hobs no tools. */
  static readonly chatOnly = Layer.succeed(HobTools, HobTools.of({ access: () => Effect.succeed(null) }));
}

/** What the hob may do with tools now, read again from its stored policy; null once it is gone. */
export const accessNow = (
  repo: HobbotsRepository["Service"],
  hobTools: HobTools["Service"],
  agentId: AgentId,
  turn?: TurnStart,
) =>
  repo
    .findAgent(agentId)
    .pipe(
      Effect.flatMap(
        Option.match({ onNone: () => Effect.succeed(null), onSome: (agent) => hobTools.access(agent, turn) }),
      ),
    );
