import { TaskNotFound, UserSession } from "@hobbots/api";
import type { Actor, Claim, ClaimClash, ClaimId, ClaimScope, Committed, TaskId, ThreadId } from "@hobbots/domain";
import { Context, DateTime, Effect, Option } from "effect";
import { EventPublisher } from "./ports.ts";
import { TaskRepository } from "./tasks.ts";

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

/** Your takeover of a Task's claims (#1449): which Task, who took it over and when. */
export interface TakeOverRequest {
  readonly taskId: TaskId;
  readonly by: Actor;
  readonly at: string;
}

/** Giving back what you took over of a Task (#1538): which Task, who gave it back and when. */
export type GiveBackRequest = TakeOverRequest;

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
    /**
     * Moves the Task's open claims to you (#1449): each becomes yours, its hob hears of it through
     * its backpack in the same transaction, and the hub refuses its writes to them until the Task
     * ends. Returns the claims it moved; none when the Task holds no open claim or you hold them all.
     */
    readonly takeOver: (request: TakeOverRequest) => Effect.Effect<Committed<ReadonlyArray<Claim>>>;
    /**
     * Gives the Task's taken claims back to the hob that owns it now (#1538), in one transaction:
     * each goes back to held, or to contested when another Task's open claim clashes with it, with
     * its own `ClaimGivenBack` event, and the hob hears once through its backpack what it may write
     * again. This is the one place a claim stops being taken before its Task ends, so the hub's
     * write check, which reads the register on every call, stops refusing at once. Returns the
     * claims it gave back; none when you took over nothing of the Task.
     */
    readonly giveBack: (request: GiveBackRequest) => Effect.Effect<Committed<ReadonlyArray<Claim>>>;
    /** The claims you took over in a repository, by its identity across clones, oldest first. */
    readonly takenIn: (repository: string) => Effect.Effect<ReadonlyArray<Claim>>;
    /** Whether you took over any claim at all, in any repository (#1537). */
    readonly anyTaken: Effect.Effect<boolean>;
  }
>()("@hobbots/agents/ClaimRegister") {}

/**
 * Moves a Task's claims as you asked, from a device session of yours (PE-006): the register writes
 * the move with its events and backpack item in one transaction, then they are published.
 */
const moveTaskClaims = (
  taskId: TaskId,
  move: (
    register: ClaimRegister["Service"],
    request: TakeOverRequest,
  ) => Effect.Effect<Committed<ReadonlyArray<Claim>>>,
) =>
  Effect.gen(function* () {
    const session = yield* UserSession;
    const tasks = yield* TaskRepository;
    const publisher = yield* EventPublisher;
    const tree = yield* tasks.readTree(taskId);
    if (Option.isNone(tree)) return yield* new TaskNotFound({ taskId });
    const register = yield* ClaimRegister;
    const at = DateTime.formatIso(yield* DateTime.now);
    const committed = yield* move(register, { taskId, by: session.actor, at });
    yield* publisher.publish(committed.entries);
    return committed.value;
  });

/**
 * Takes over a Task's files and branches (#1449): its open claims move to you, and its hob hears of
 * it in its backpack. Only a `UserSession` can, so no hob, Charm or runtime tool takes work from
 * another (PE-006). The Task keeps running: the hub refuses only its writes to what you took over.
 * Taking over a hob's live browser is not part of it; it waits for its own decision (#382).
 */
export const takeOverTask = (taskId: TaskId) =>
  moveTaskClaims(taskId, (register, request) => register.takeOver(request));

/**
 * Gives back a Task's files and branches you took over (#1538): its hob may write to them again,
 * and hears so in its backpack. Only a `UserSession` can, as with Take over (PE-006). A Reassign
 * after it hands them over with the Task, since claims belong to the Task, not to its hob.
 */
export const giveBackTask = (taskId: TaskId) =>
  moveTaskClaims(taskId, (register, request) => register.giveBack(request));
