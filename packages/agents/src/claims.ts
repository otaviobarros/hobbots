import type { Actor, Claim, ClaimClash, ClaimId, ClaimScope, Committed, TaskId, ThreadId } from "@hobbots/domain";
import { Context, type Effect } from "effect";

/** A claim to record (ADR 037): what it is on, which Task holds it and who made it. */
export interface ClaimRequest {
  readonly id: ClaimId;
  readonly scope: ClaimScope;
  /** Who the repository is across clones and worktrees. */
  readonly repository: string;
  /** For a sequence, the folder inside the repository its numbers count in; null otherwise. */
  readonly directory: string | null;
  /** For a path or a branch, its key; null for a number, which the register picks. */
  readonly key: string | null;
  /** For a sequence: the numbers the repository's `main` already has in `directory`. */
  readonly onMain: ReadonlyArray<number>;
  /** For a sequence: the number the hob already uses, kept when it is free. */
  readonly asked: number | null;
  readonly taskId: TaskId;
  readonly actor: Actor;
  readonly at: string;
}

/**
 * What a claim came to: a new claim, with the open claims it clashes with, and for a number, the
 * one asked for when another had it; or the open claim the same Task already holds on that path
 * or branch, which changes nothing.
 */
export type ClaimOutcome =
  | {
      readonly _tag: "Made";
      readonly claim: Claim;
      readonly clashes: ReadonlyArray<Claim>;
      readonly taken: number | null;
    }
  | { readonly _tag: "Held"; readonly claim: Claim; readonly clashes: ReadonlyArray<Claim> };

/**
 * The claims register (ADR 037), by the hub's database. A claim is written with its events, the
 * claims it contests and the backpack items its clashes call for in one transaction. Claims are
 * released in the transaction that ends their Task.
 */
export class ClaimRegister extends Context.Service<
  ClaimRegister,
  {
    readonly claim: (request: ClaimRequest) => Effect.Effect<Committed<ClaimOutcome>>;
    /** A Task's claims, oldest first, released ones included. */
    readonly ofTask: (taskId: TaskId) => Effect.Effect<ReadonlyArray<Claim>>;
    /**
     * The open clashes a chat or camp shows as a Heads-up (#1390): each group of open claims that
     * clash, one of them contested by a Task whose work belongs to the thread, oldest first.
     */
    readonly clashesIn: (threadId: ThreadId) => Effect.Effect<ReadonlyArray<ClaimClash>>;
  }
>()("@hobbots/agents/ClaimRegister") {}
