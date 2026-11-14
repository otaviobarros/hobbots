import {
  EventPublisher,
  HobbotsRepository,
  SupervisionRecords,
  TaskRepository,
  TaskTurns,
  workHeld,
} from "@hobbots/agents";
import {
  type AgentId,
  type Committed,
  descendantsOf,
  HUB_ACTOR,
  hobStanding,
  isTerminalTask,
  liveAttemptOn,
  NoteId,
  type TaskId,
  type TaskTree,
} from "@hobbots/domain";
import { Context, DateTime, Duration, Effect, Layer, Option } from "effect";
import { type Act, decide, nextDeadline, stopOrder } from "./rules.ts";

/** How often the supervisor looks over the work, at the latest: sooner when a deadline falls first. */
const DEFAULT_EVERY = Duration.seconds(15);

/** Each hob that owns work or is asked a question in the tree, once. */
const involved = (tree: TaskTree): ReadonlyArray<AgentId> => [
  ...new Set<AgentId>([
    ...tree.tasks.map((each) => each.ownerId),
    ...tree.questions.flatMap((each) => (each.recipientId === null ? [] : [each.recipientId])),
  ]),
];

/** What one look over the work did. */
export interface SupervisionPass {
  /** Each act the records took, in the order made. */
  readonly acted: ReadonlyArray<Act["_tag"]>;
  /** The next deadline of work still open, when the supervisor should look again (epoch milliseconds). */
  readonly nextDue: number | null;
}

/**
 * The supervisor (#1447): looks over the work under every Task you asked for that is at work, by
 * the rules in `rules.ts`, and makes each act through the records, so the lead hears of it as it
 * hears of anything else. It runs on its own schedule beside the step runner and never calls a model.
 */
export class Supervisor extends Context.Service<
  Supervisor,
  {
    /** Looks over the work once, as at `at` (now when absent). */
    readonly pass: (at?: string) => Effect.Effect<SupervisionPass>;
  }
>()("@hobbots/supervision/Supervisor") {
  /**
   * The supervisor, looking again at least `every` (15 seconds by default) and as each deadline
   * falls. With `every: null` it looks only when `pass` is called, as tests drive it.
   */
  static readonly layer = (options: { readonly every?: Duration.Input | null } = {}) =>
    Layer.effect(
      Supervisor,
      Effect.gen(function* () {
        const tasks = yield* TaskRepository;
        const repo = yield* HobbotsRepository;
        const records = yield* SupervisionRecords;
        const publisher = yield* EventPublisher;
        const held = yield* workHeld;
        // The runner that stops turns and starts what is ready; absent, nothing runs to stop.
        const turns = yield* Effect.serviceOption(TaskTurns);

        const review = Option.isSome(turns) ? turns.value.reviewTasks : Effect.void;

        /** A change the act makes in the records, which may refuse it; none when it changes nothing. */
        type Change = Effect.Effect<ReadonlyArray<Committed<unknown>>, unknown>;
        const one = <A, E>(change: Effect.Effect<Committed<A>, E>): Change => Effect.map(change, (done) => [done]);
        const NOTHING: Change = Effect.succeed([]);

        const readTree = (rootId: TaskId) => Effect.map(tasks.readTree(rootId), Option.getOrUndefined);

        /** Where each hob that owns work or is asked a question in the tree stands now. */
        const standings = (tree: TaskTree) =>
          Effect.map(
            Effect.forEach(involved(tree), (id) =>
              Effect.map(repo.findAgent(id), (hob) => ({
                id,
                standing: Option.getOrNull(Option.map(hob, hobStanding)),
              })),
            ),
            (found) => (agentId: AgentId) => found.find((each) => each.id === agentId)?.standing ?? null,
          );

        /** A note from Hobbots on the Task for its nearest lead at work, once for each `key`. */
        const tell = (taskId: TaskId, key: string, text: string, at: string) =>
          one(
            tasks.leaveNote({
              id: NoteId.make(`supervisor:${taskId}:${key}`),
              taskId,
              text,
              createdAt: at,
              author: HUB_ACTOR,
            }),
          );

        /**
         * Stops a Task past its deadline: the turns running in it and under it first, then, once none
         * runs, every Task in it still open fails, deepest first, the Task itself with the reason its
         * lead reads. A Task the runner already ended as its turn stopped is told instead. Undefined
         * while a turn or a cancel under it has still to end: the next look ends it.
         */
        const stop = (act: Extract<Act, { _tag: "Stop" }>, at: string) =>
          Effect.gen(function* () {
            const before = yield* readTree(act.task.rootId);
            if (before === undefined) return undefined;
            const live = stopOrder(act.task, before).filter((each) => liveAttemptOn(each, before));
            if (live.length > 0 && Option.isSome(turns)) yield* turns.value.stopOverdue(live.map((each) => each.id));
            const tree = yield* readTree(act.task.rootId);
            const task = tree?.tasks.find((each) => each.id === act.task.id);
            if (tree === undefined || task === undefined) return undefined;
            // The runner may have ended it as its turn stopped, as it fails a step: its lead is told instead.
            if (isTerminalTask(task.state)) return act.first ? tell(task.id, "deadline", act.reason, at) : NOTHING;
            const ending = stopOrder(task, tree);
            if (ending.some((each) => liveAttemptOn(each, tree))) return undefined;
            if (descendantsOf(task, tree.tasks).some((each) => each.state === "cancelling")) return undefined;
            return Effect.forEach(ending, (each) =>
              tasks.moveTask(each.id, each.revision, "failed", at, each.id === task.id ? { reason: act.reason } : {}),
            ) as Change;
          });

        /** The change an act makes, or undefined when it waits for the next look. */
        const changeFor = (act: Act, at: string): Effect.Effect<Change | undefined> => {
          switch (act._tag) {
            case "Stop":
              return stop(act, at);
            case "Retry":
              return Effect.succeed(
                one(tasks.retryTask(act.task.id, act.task.revision, at, { actor: HUB_ACTOR, reason: act.reason })),
              );
            case "Fail":
              return Effect.succeed(
                one(tasks.moveTask(act.task.id, act.task.revision, "failed", at, { reason: act.reason })),
              );
            case "Tell":
              return Effect.succeed(tell(act.task.id, act.key, act.text, at));
            case "Route":
              return Effect.succeed(one(tasks.escalateQuestion(act.question.id, act.from)));
            case "Clear":
              return Effect.succeed(NOTHING);
          }
        };

        /**
         * Makes one act: its change and the Task's record commit together, journaled, or neither does
         * (STD-ARCH-014), as when the Task moved on meanwhile and the records refuse it. Whether it did.
         */
        const make = (act: Act, at: string) =>
          Effect.gen(function* () {
            const change = yield* changeFor(act, at);
            if (change === undefined) return false;
            const committed = yield* tasks.atomically(
              Effect.gen(function* () {
                const done = yield* change;
                return [...done, yield* records.save(act.record)];
              }),
            );
            for (const each of committed) yield* publisher.publish(each.entries);
            return true;
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning(`The supervisor could not act (${act._tag})`, cause).pipe(Effect.as(false)),
            ),
          );

        /** Looks over one tree: decides, and makes each act. */
        const supervise = (rootId: TaskId, at: string) =>
          Effect.gen(function* () {
            const tree = yield* readTree(rootId);
            if (tree === undefined) return { acted: [] as Array<Act["_tag"]>, nextDue: null };
            const kept = new Map((yield* records.listIn(rootId)).map((each) => [each.taskId, each] as const));
            const acts = decide({ tree, records: kept, standing: yield* standings(tree), at });
            const acted: Array<Act["_tag"]> = [];
            for (const act of acts) if (yield* make(act, at)) acted.push(act._tag);
            return { acted, nextDue: nextDeadline(tree, at) };
          });

        const pass = (at?: string): Effect.Effect<SupervisionPass> =>
          Effect.gen(function* () {
            // After a restore nothing runs until you resume work (ADR 026), so nothing is overdue either.
            if (yield* held) return { acted: [], nextDue: null };
            const now = at ?? DateTime.formatIso(yield* DateTime.now);
            const acted: Array<Act["_tag"]> = [];
            let nextDue: number | null = null;
            for (const rootId of yield* tasks.listRootsAtWork) {
              const done = yield* supervise(rootId, now);
              acted.push(...done.acted);
              if (done.nextDue !== null) nextDue = nextDue === null ? done.nextDue : Math.min(nextDue, done.nextDue);
            }
            if (acted.length > 0) yield* review;
            return { acted, nextDue };
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("The supervisor could not look over the work", cause).pipe(
                Effect.as({ acted: [], nextDue: null }),
              ),
            ),
          );

        const every = options.every === undefined ? DEFAULT_EVERY : options.every;
        if (every !== null) {
          const most = Duration.toMillis(every);
          const loop = Effect.gen(function* () {
            const { nextDue } = yield* pass();
            const now = Date.parse(DateTime.formatIso(yield* DateTime.now));
            const wait = nextDue === null ? most : Math.min(most, Math.max(nextDue - now, 0) + 1);
            yield* Effect.sleep(Duration.millis(wait));
          });
          yield* Effect.forkScoped(Effect.forever(loop));
        }

        return Supervisor.of({ pass });
      }),
    );
}
