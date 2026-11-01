import { HobbotsRepository, HobTools, operationDecision, TaskRepository } from "@hobbots/agents";
import {
  type AgentId,
  ancestorsOf,
  type Committed,
  DEFAULT_QUEST_LIMITS,
  type EventEnvelope,
  IllegalTaskTransition,
  isTerminalTask,
  POLICY_OPERATIONS,
  type QuestLimits,
  questPlacement,
  questsAbove,
  StaleTask,
  type Task,
  type TaskId,
  type TaskRefused,
  TaskToolRefused,
  type TaskTree,
} from "@hobbots/domain";
import { Effect, Option } from "effect";
import { type Authority, NO_AUTHORITY, narrowBy, type PathSeparator } from "./authority.ts";

/**
 * Limits the hub holds every call to (orchestration contract). Depth counts Quests, not steps.
 * Open Tasks are those that have not ended, whether or not they run yet: running concurrency is
 * the scheduler's to bound.
 */
export interface TaskToolLimits {
  readonly maxDepth: number;
  /** Open Tasks one hob may own, across every tree. */
  readonly maxOpenTasksPerHob: number;
  /** Open Tasks in one request's tree: the Task you asked for and everything under it. */
  readonly maxOpenTasksPerTree: number;
}

export const DEFAULT_TASK_TOOL_LIMITS: TaskToolLimits = {
  maxDepth: DEFAULT_QUEST_LIMITS.maxDepth,
  maxOpenTasksPerHob: 16,
  maxOpenTasksPerTree: 32,
};

/** Who calls: the hob whose turn it is, and the Task that turn works on. Never taken from the input. */
export interface TaskToolCaller {
  readonly agentId: AgentId;
  readonly taskId: TaskId;
}

/** What a tool handler sees: the caller, its Task, that Task's whole tree as read in the call's transaction, and now. */
export interface CallScope {
  readonly caller: TaskToolCaller;
  readonly turnTask: Task;
  readonly tree: TaskTree;
  readonly at: string;
}

export const refuse = (reason: TaskToolRefused["reason"], message: string) =>
  Effect.fail(new TaskToolRefused({ reason, message }));

/** A refusal by the records themselves, told to the hob in the same words. */
export const fromRecords = <A>(
  effect: Effect.Effect<A, TaskRefused | StaleTask | IllegalTaskTransition>,
): Effect.Effect<A, TaskToolRefused> =>
  Effect.mapError(effect, (error) => {
    if (error instanceof IllegalTaskTransition) {
      return new TaskToolRefused({
        reason: "task-state",
        message: `Task ${error.taskId} is ${error.from}, so it cannot become ${error.to}.`,
      });
    }
    if (error instanceof StaleTask) {
      return new TaskToolRefused({
        reason: "task-state",
        message: `Task ${error.taskId} changed meanwhile; try again.`,
      });
    }
    return new TaskToolRefused({ reason: error.reason, message: error.message });
  });

/** Collects the journal entries of each change a call makes, to announce once it commits. */
export const journalOf = () => {
  const entries: Array<EventEnvelope> = [];
  return {
    entries,
    keep: <A>(committed: Committed<A>): A => {
      entries.push(...committed.entries);
      return committed.value;
    },
  };
};

export const newId = () => crypto.randomUUID();

/** A Task of the call's tree, or a refusal naming it. */
/**
 * The Tasks a turn reaches: the Task it works on and everything under it. A step's session never
 * reaches its sibling, and a member working on one branch never reaches another.
 */
const withinTurn = (scope: CallScope, task: Task): boolean =>
  task.id === scope.turnTask.id || ancestorsOf(task, scope.tree.tasks).some((above) => above.id === scope.turnTask.id);

/** A Task the turn reaches, or a refusal naming it. */
export const taskIn = (scope: CallScope, id: string): Effect.Effect<Task, TaskToolRefused> => {
  const task = scope.tree.tasks.find((each) => each.id === id);
  return task === undefined || !withinTurn(scope, task)
    ? refuse("outside-subtree", `Task ${id} is not part of the Task you are working on.`)
    : Effect.succeed(task);
};

/** The Task a call names, or the turn's own Task when it names none, which the caller must own. */
export const ownTask = (scope: CallScope, id: string | undefined): Effect.Effect<Task, TaskToolRefused> =>
  Effect.flatMap(taskIn(scope, id ?? scope.turnTask.id), (task) =>
    task.ownerId === scope.caller.agentId
      ? Effect.succeed(task)
      : refuse("not-owner", `Task ${task.id} is not yours; only its owner can do this.`),
  );

/** A Task the caller leads from this turn: it owns a Task above it, the turn's own or one under it. */
export const ledTask = (scope: CallScope, id: string): Effect.Effect<Task, TaskToolRefused> =>
  Effect.flatMap(taskIn(scope, id), (task) =>
    ancestorsOf(task, scope.tree.tasks).some(
      (above) => above.ownerId === scope.caller.agentId && withinTurn(scope, above),
    )
      ? Effect.succeed(task)
      : refuse("not-lead", `Task ${task.id} is not under any Task of yours.`),
  );

/** A Quest's deadline: the one asked for, never later than the one above it, and not passed. */
const deadlineWithin = (scope: CallScope, above: string | null, asked: string | undefined) =>
  Effect.gen(function* () {
    const deadline = asked ?? above;
    if (deadline === null) return null;
    if (Number.isNaN(Date.parse(deadline))) {
      return yield* refuse("invalid-input", `The deadline ${deadline} is not an ISO 8601 time.`);
    }
    if (above !== null && Date.parse(deadline) > Date.parse(above)) {
      return yield* refuse("authority-wider", `The deadline cannot be later than ${above}.`);
    }
    if (Date.parse(deadline) <= Date.parse(scope.at)) {
      return yield* refuse("deadline-passed", `The deadline ${deadline} has passed.`);
    }
    return deadline;
  });

/**
 * Where a Quest on `task` sits, refused when it would be deeper than the hub or any Quest above it
 * allows. Every Quest on the way up counts, whichever started first.
 */
export const depthWithin = (scope: CallScope, limits: TaskToolLimits, task: Task) =>
  Effect.gen(function* () {
    const { depth } = questPlacement(task, scope.tree.tasks, scope.tree.quests);
    const above = questsAbove(task, scope.tree.tasks, scope.tree.quests).filter((quest) => quest.taskId !== task.id);
    const allowed = Math.min(limits.maxDepth, ...above.map((quest) => quest.limits.maxDepth));
    if (depth > allowed) {
      return yield* refuse(
        "depth-limit",
        `This would be a Quest ${depth} deep, past the limit of ${allowed}. Do this work yourself, or split it into steps.`,
      );
    }
    return { above, allowed };
  });

/** The Quest limits a new Quest on `task` gets: within the hub's and every Quest's above it. */
export const questLimitsFor = (
  scope: CallScope,
  limits: TaskToolLimits,
  task: Task,
  requested: { readonly max_depth?: number; readonly deadline?: string },
): Effect.Effect<QuestLimits, TaskToolRefused> =>
  Effect.gen(function* () {
    const { above, allowed } = yield* depthWithin(scope, limits, task);
    const maxDepth = requested.max_depth ?? allowed;
    if (maxDepth > allowed) return yield* refuse("authority-wider", `The depth limit here is at most ${allowed}.`);
    const deadlines = above.flatMap((quest) => (quest.limits.deadline === null ? [] : [quest.limits.deadline]));
    const earliest = deadlines.reduce<string | null>(
      (first, each) => (first === null || Date.parse(each) < Date.parse(first) ? each : first),
      null,
    );
    const deadline = yield* deadlineWithin(scope, earliest, requested.deadline);
    return { maxDepth, deadline };
  });

/** Refuses new work for `ownerId` once it would own more open Tasks than the hub allows a hob. */
export const makeHobRoom = (limits: TaskToolLimits) =>
  Effect.gen(function* () {
    const tasks = yield* TaskRepository;
    return (ownerId: AgentId, adding: number) =>
      Effect.gen(function* () {
        const own = yield* tasks.openTaskCount(ownerId);
        if (own + adding > limits.maxOpenTasksPerHob) {
          return yield* refuse(
            "concurrency-limit",
            `Hob ${ownerId} has ${own} open Tasks; the limit is ${limits.maxOpenTasksPerHob}. Wait for some to end.`,
          );
        }
      });
  });

/** Refuses new work for `ownerId` once it, or the tree, would hold more open Tasks than the limits allow. */
export const makeCapacity = (limits: TaskToolLimits) =>
  Effect.gen(function* () {
    const hobRoom = yield* makeHobRoom(limits);
    return (scope: CallScope, ownerId: AgentId, adding: number) =>
      Effect.gen(function* () {
        yield* hobRoom(ownerId, adding);
        const inTree = scope.tree.tasks.filter((task) => !isTerminalTask(task.state)).length;
        if (inTree + adding > limits.maxOpenTasksPerTree) {
          return yield* refuse(
            "concurrency-limit",
            `This work has ${inTree} open Tasks; the limit is ${limits.maxOpenTasksPerTree}. Wait for some to end.`,
          );
        }
      });
  });

/**
 * What the caller may do on `task`: its own policy now, narrowed by every Delegation on the way
 * down to the Task, so a member never passes on more than it was given (STD-SEC-003).
 */
export const makeAuthorityOf = (separator: PathSeparator) =>
  Effect.gen(function* () {
    const hobs = yield* HobbotsRepository;
    const hobTools = yield* HobTools;
    /** What a hob's own policy lets it do now. */
    const ownAuthority = (agentId: AgentId) =>
      Effect.gen(function* () {
        const agent = yield* hobs.findAgent(agentId);
        const access = Option.isNone(agent) ? null : yield* hobTools.access(agent.value);
        const own: Authority =
          access === null
            ? NO_AUTHORITY
            : {
                decisions: Object.fromEntries(
                  POLICY_OPERATIONS.map((operation) => [operation, operationDecision(access.policy, operation)]),
                ) as Authority["decisions"],
                folders: access.folders,
              };
        return own;
      });
    const of = (scope: CallScope, task: Task) =>
      Effect.gen(function* () {
        const own = yield* ownAuthority(scope.caller.agentId);
        const path = new Set([task.id, ...ancestorsOf(task, scope.tree.tasks).map((each) => each.id)]);
        return scope.tree.delegations
          .filter((delegation) => path.has(delegation.childTaskId))
          .reduce((authority, delegation) => narrowBy(authority, delegation.authority, separator), own);
      });
    return { of, own: ownAuthority };
  });
