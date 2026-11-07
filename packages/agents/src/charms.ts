import type { AgentId, AttemptId, MessageId, ThreadId } from "@hobbots/domain";
import { Context, Effect, Option, Schema, type Scope } from "effect";
import { MemoryTools } from "./memory.ts";
import type { HubToolAnswer, HubTools, ToolAccess, TurnApprovals } from "./runtime.ts";
import type { Redactor } from "./secrets.ts";
import { SkillTools } from "./skill-proposals.ts";

/** A turn that may offer Charm tools: its hob, and how to read the hob's tool access now. */
export interface CharmTurn {
  readonly agentId: AgentId;
  /** The thread and reply the turn writes, so a Charm call's record names the step it showed as. */
  readonly threadId: ThreadId | null;
  readonly messageId: MessageId | null;
  /** The Attempt a turn outside any chat runs as, so a call it makes names the session it belongs to (#1049). */
  readonly attemptId?: AttemptId;
  /** The work the turn's call keys belong to now (#660), from `callScope`, as its Task tools key theirs. */
  readonly scope: () => string;
  /** Another scope a retry of a key is found in: the turn's reply, as for its Task tools. */
  readonly also?: string;
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
    /**
     * The Charm tools the turn offers, read at its start: none (null) for a hob without the Charm
     * or while its app is not connected, so a change applies from the next turn.
     */
    readonly forTurn: (turn: CharmTurn) => Effect.Effect<HubTools | null>;
  }
>()("@hobbots/agents/CharmTools") {}

/**
 * The local Git work a turn's hob asks the hub to do outside its turn's sandbox (ADR 014), such as creating
 * a repository, whose config and hooks the sandbox keeps read-only. The hub decides every call under
 * the hob's policy. Absent, a turn offers none.
 */
export class LocalGitTools extends Context.Service<
  LocalGitTools,
  {
    /** The tools the turn offers, read at its start: none (null) for a turn without folders. */
    readonly forTurn: (turn: CharmTurn) => Effect.Effect<HubTools | null>;
  }
>()("@hobbots/agents/LocalGitTools") {}

/**
 * A hub tool call's answer as the hob reads it: a refusal, with its reason, as a refused answer, and
 * every answer redacted, as everything a hob reads is.
 */
export const hubAnswer = <R>(
  redactor: Redactor,
  call: Effect.Effect<HubToolAnswer, { readonly _tag: "Refused"; readonly message: string }, R>,
): Effect.Effect<HubToolAnswer, never, R> =>
  call.pipe(
    Effect.catchTag("Refused", (refused) => Effect.succeed<HubToolAnswer>({ text: refused.message, refused: true })),
    Effect.map((answer) => ({ ...answer, text: redactor.text(answer.text) })),
  );

/** The first answer any of `sets` gives for a folder that is not null, or null when none does. */
const firstOf =
  (
    sets: ReadonlyArray<HubTools>,
    pick: (set: HubTools) => ((cwd: string) => Effect.Effect<string | null>) | undefined,
  ) =>
  (cwd: string): Effect.Effect<string | null> =>
    Effect.gen(function* () {
      for (const set of sets) {
        const answer = pick(set);
        const found = answer ? yield* answer(cwd) : null;
        if (found !== null) return found;
      }
      return null;
    });

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
    steersPush: firstOf(given, (set) => set.steersPush),
    holdsCommit: firstOf(given, (set) => set.holdsCommit),
  };
};

/**
 * The local Git, Charm, memory and skill tools a turn offers, read at its start under the access the turn
 * reads (ADR 014): a chat turn's, a party member's or a step's, each narrowed by its Delegations.
 * Every kind of turn that offers Task tools offers them this one way, so the tools a delegation
 * promises are the tools its member gets (#699), and every runtime that serves hub tools serves
 * memory (ADR 028) and skills (ADR 029). Without a service, a turn offers none of its tools.
 */
export const charmOffer = Effect.gen(function* () {
  const localGit = yield* Effect.serviceOption(LocalGitTools);
  const charms = yield* Effect.serviceOption(CharmTools);
  const memory = yield* Effect.serviceOption(MemoryTools);
  const skills = yield* Effect.serviceOption(SkillTools);
  // Each reads the turn's access itself, so they are read side by side.
  return (turn: CharmTurn) =>
    Effect.all(
      [
        Option.isSome(localGit) ? localGit.value.forTurn(turn) : Effect.succeed(null),
        Option.isSome(charms) ? charms.value.forTurn(turn) : Effect.succeed(null),
        Option.isSome(memory) ? memory.value.forTurn(turn) : Effect.succeed(null),
        Option.isSome(skills) ? skills.value.forTurn(turn) : Effect.succeed(null),
      ],
      { concurrency: "unbounded" },
    ).pipe(Effect.map((sets) => combineHubTools(...sets)));
});

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
