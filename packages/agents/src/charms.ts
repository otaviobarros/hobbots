import type { AgentId, MessageId, ThreadId } from "@hobbots/domain";
import { Context, Effect, Schema, type Scope } from "effect";
import type { HubTools, ToolAccess, TurnApprovals } from "./runtime.ts";
import type { Redactor } from "./secrets.ts";

/** A turn that may offer Charm tools: its hob, and how to read the hob's tool access now. */
export interface CharmTurn {
  readonly agentId: AgentId;
  /** The thread and reply the turn writes, so a Charm call's record names the step it showed as. */
  readonly threadId: ThreadId | null;
  readonly messageId: MessageId | null;
  /** The hob's tool access now, read again for every call so a narrower policy applies to the next (PE-008). */
  readonly currentAccess: Effect.Effect<ToolAccess | null>;
  /** Redacts secrets from what a call returns, before the hob reads it. */
  readonly redactor: Redactor;
  /** Asks the user about calls the policy answers Ask for; null, those calls are refused. */
  readonly approvals: TurnApprovals | null;
}

/**
 * The Charms a turn offers its runtime (ADR 014), served on the hub outside the sandbox, which
 * holds their credentials. The hub decides every call under the hob's policy. Absent, a turn
 * offers none.
 */
export class CharmTools extends Context.Service<
  CharmTools,
  {
    readonly forTurn: (turn: CharmTurn) => HubTools;
  }
>()("@hobbots/agents/CharmTools") {}

/**
 * Every tool of several sets, as one: a call goes to the set that offers its tool. A name two sets
 * offer goes to the first. Null when no set is given.
 */
export const combineHubTools = (...sets: ReadonlyArray<HubTools | null>): HubTools | null => {
  const given = sets.filter((set): set is HubTools => set !== null);
  if (given.length <= 1) return given[0] ?? null;
  const owner = new Map<string, HubTools>();
  for (const set of given) for (const tool of set.tools) if (!owner.has(tool.name)) owner.set(tool.name, set);
  const tools = given.flatMap((set) => set.tools.filter((tool) => owner.get(tool.name) === set));
  return {
    tools,
    // A tool no set offers goes to the first, which refuses it in its own words.
    call: (name, input, step) => (owner.get(name) ?? (given[0] as HubTools)).call(name, input, step),
    steersPush: (cwd) =>
      Effect.gen(function* () {
        for (const set of given) {
          const tool = set.steersPush ? yield* set.steersPush(cwd) : null;
          if (tool !== null) return tool;
        }
        return null;
      }),
  };
};

/**
 * A program that runs inside a hob's sandbox: a shell command line, and the variables its process
 * needs on top of the caller's own. Arguments a caller appends to the line are not passed on.
 */
export interface SandboxedProgram {
  readonly commandLine: string;
  readonly env: Readonly<Record<string, string>>;
}

/** Why a program cannot run in the sandbox, in words for the hob and the person. */
export class SandboxUnavailable extends Schema.TaggedError<SandboxUnavailable>()("SandboxUnavailable", {
  message: Schema.String,
}) {}

/**
 * Runs a Charm's reads of a hob's folders in the same OS sandbox as the hob's turns (ADR 020): able
 * to read only those folders, write nothing of the hob's and reach no network. Whatever a folder's
 * files point at, the program reads nothing outside them. The sandbox lasts as long as the scope.
 */
export class FolderSandbox extends Context.Service<
  FolderSandbox,
  {
    readonly readOnly: (
      folders: ReadonlyArray<string>,
      program: string,
      args: ReadonlyArray<string>,
    ) => Effect.Effect<SandboxedProgram, SandboxUnavailable, Scope.Scope>;
  }
>()("@hobbots/agents/FolderSandbox") {}
