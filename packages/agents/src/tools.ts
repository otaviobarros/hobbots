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
import type { HobbotsRepository } from "./repository.ts";
import type { ToolAccess, ToolPolicy } from "./runtime.ts";

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
  { readonly access: (agent: Agent) => Effect.Effect<ToolAccess | null> }
>()("@hobbots/agents/HobTools") {
  /** Every turn chat-only, for hubs and tests that give hobs no tools. */
  static readonly chatOnly = Layer.succeed(HobTools, HobTools.of({ access: () => Effect.succeed(null) }));
}

/** What the hob may do with tools now, read again from its stored policy; null once it is gone. */
export const accessNow = (repo: HobbotsRepository["Service"], hobTools: HobTools["Service"], agentId: AgentId) =>
  repo
    .findAgent(agentId)
    .pipe(
      Effect.flatMap(Option.match({ onNone: () => Effect.succeed(null), onSome: (agent) => hobTools.access(agent) })),
    );
