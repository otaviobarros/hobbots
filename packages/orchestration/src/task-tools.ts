import {
  type ChatTaskTurn,
  type ChatTurn,
  EventPublisher,
  FolderChecks,
  HobbotsRepository,
  type HubTools,
  TaskRepository,
  TaskToolCalls,
  type TaskToolOutcome,
} from "@hobbots/agents";
import {
  type AttemptId,
  type EventEnvelope,
  isTaskToolName,
  stableJson,
  TASK_TOOLS,
  type TaskToolDone,
  TaskToolInputs,
  type TaskToolName,
  TaskToolRefused,
  taskToolJsonSchema,
  taskToolText,
} from "@hobbots/domain";
import { Context, DateTime, Effect, Layer, Option, Schema } from "effect";
import { makeAsking } from "./asking.ts";
import type { PathSeparator } from "./authority.ts";
import {
  type CallScope,
  DEFAULT_TASK_TOOL_LIMITS,
  makeAuthorityOf,
  makeCapacity,
  refuse,
  type TaskToolCaller,
  type TaskToolLimits,
} from "./call-scope.ts";
import { makeChatResolver, type ResolvedCaller } from "./chat-turns.ts";
import { makeDelegating } from "./delegating.ts";
import { makePlanning } from "./planning.ts";
import { TaskSignal } from "./signal.ts";

type ToolHandler = (scope: CallScope, input: never) => Effect.Effect<TaskToolOutcome, TaskToolRefused>;

const describe = (error: Schema.SchemaError) => error.message.split("\n").slice(0, 6).join("\n");

const COULD_NOT_RECORD = "Hobbots could not record this call, so it did not happen. Try again with the same key.";

/**
 * Who a call comes from: a turn on a known Task, or a chat turn whose Task is found, or started,
 * inside the call's own transaction. `turn` tells a retried key from another turn's.
 */
interface CallSource {
  readonly turn: Record<string, string>;
  readonly resolve: (name: TaskToolName, at: string) => Effect.Effect<ResolvedCaller, TaskToolRefused>;
}

/**
 * The Hobbots tools for Tasks and Quests (ADR 018). Every call is checked by the hub: who may make
 * it, depth, open-Task limits, cycles and authority. A refused call writes nothing and says why;
 * a call with a key already used returns its first result.
 */
export class TaskTools extends Context.Service<
  TaskTools,
  {
    /** Decides and makes one call for the caller. */
    readonly call: (
      caller: TaskToolCaller,
      name: string,
      input: unknown,
    ) => Effect.Effect<TaskToolDone, TaskToolRefused>;
    /**
     * The tools a turn on the caller's Task offers its runtime: every tool, or only those named in
     * `only`. A call to a tool the turn does not offer is refused.
     */
    readonly forTurn: (caller: TaskToolCaller, only?: ReadonlyArray<TaskToolName>) => HubTools;
    /**
     * The tools a chat turn offers, on the open Task its hob owns in the thread. A call that starts
     * work starts that Task from the turn's prompt when there is none; each turn that starts a Task
     * or returns its result runs it as an Attempt, which ends with the turn.
     */
    readonly forChat: (turn: ChatTurn) => Effect.Effect<ChatTaskTurn>;
  }
>()("@hobbots/orchestration/TaskTools") {
  /**
   * `separator` is the hub's own path separator, which alone divides the folders a hob may be
   * given (STD-SEC-003).
   */
  static readonly layer = (separator: PathSeparator, limits: TaskToolLimits = DEFAULT_TASK_TOOL_LIMITS) =>
    Layer.effect(
      TaskTools,
      Effect.gen(function* () {
        const tasks = yield* TaskRepository;
        const ledger = yield* TaskToolCalls;
        const publisher = yield* EventPublisher;
        const capacity = yield* makeCapacity(limits);
        const authority = yield* makeAuthorityOf(separator);
        const folderChecks = yield* FolderChecks;
        const hobs = yield* HobbotsRepository;
        const handlers: Record<TaskToolName, ToolHandler> = {
          ...makePlanning({ tasks, capacity, limits }),
          ...makeDelegating({ tasks, capacity, limits, authority, folderChecks, hobs, separator }),
          ...makeAsking({ tasks }),
        };

        // Tells the step runner that Tasks changed. Absent, as in tests of the tools alone, no step runs.
        const signal = yield* Effect.serviceOption(TaskSignal);

        const scopeOf = (caller: TaskToolCaller, at: string) =>
          Effect.gen(function* () {
            const own = yield* tasks.readTree(caller.taskId);
            const turnTask = Option.isSome(own) ? own.value.tasks[0] : undefined;
            if (Option.isNone(own) || turnTask === undefined) {
              return yield* refuse("task-missing", `The Task you are working on, ${caller.taskId}, does not exist.`);
            }
            if (turnTask.ownerId !== caller.agentId) {
              return yield* refuse("not-owner", `You are not working on Task ${turnTask.id}.`);
            }
            const whole = turnTask.parentId === null ? own : yield* tasks.readTree(turnTask.rootId);
            if (Option.isNone(whole)) return yield* refuse("task-missing", `Task ${turnTask.rootId} does not exist.`);
            return { caller, turnTask, tree: whole.value, at } satisfies CallScope;
          });

        /** Makes one call; `committed` learns what the call's own transaction resolved, once it commits. */
        const callFrom = (
          agentId: TaskToolCaller["agentId"],
          source: CallSource,
          name: string,
          raw: unknown,
          committed: (resolved: ResolvedCaller) => void = () => {},
        ) =>
          Effect.gen(function* () {
            if (!isTaskToolName(name)) return yield* refuse("unknown-tool", `Hobbots has no ${name} tool.`);
            const input = yield* Schema.decodeUnknownEffect(TaskToolInputs[name])(raw).pipe(
              Effect.mapError((error) => new TaskToolRefused({ reason: "invalid-input", message: describe(error) })),
            );
            const { key, ...rest } = input;
            const at = DateTime.formatIso(yield* DateTime.now);
            // Set inside the call's transaction; read only once it has committed.
            const seen: { resolved: ResolvedCaller | null } = { resolved: null };
            const outcome = yield* ledger.once(
              { agentId, key, tool: name, input: stableJson({ ...rest, ...source.turn }), at },
              Effect.gen(function* () {
                const resolved = yield* source.resolve(name, at);
                seen.resolved = resolved;
                const scope = yield* scopeOf(resolved.caller, at);
                const made = yield* handlers[name](scope, rest as never);
                return { done: made.done, entries: [...resolved.entries, ...made.entries] };
              }),
            );
            if (seen.resolved !== null) committed(seen.resolved);
            // Committed already: a client that misses the announcement replays it from the journal.
            if (outcome.entries.length > 0) yield* announce(outcome.entries);
            return outcome.done;
          });

        const announce = (entries: ReadonlyArray<EventEnvelope>) =>
          Effect.gen(function* () {
            yield* publisher
              .publish(entries)
              .pipe(Effect.catchCause((cause) => Effect.logWarning("Could not announce a Task tool call", cause)));
            if (Option.isSome(signal)) yield* signal.value.notify;
          });

        const call = (caller: TaskToolCaller, name: string, raw: unknown) =>
          callFrom(
            caller.agentId,
            {
              turn: { turn_task: caller.taskId },
              resolve: () => Effect.succeed({ caller, entries: [], attemptId: null }),
            },
            name,
            raw,
          );

        // A runtime runs each call on its own, so it carries the hub's services, its logger included.
        const context = yield* Effect.context<never>();
        const offered = (only: ReadonlyArray<TaskToolName> | undefined) =>
          TASK_TOOLS.filter((tool) => only === undefined || only.includes(tool.name)).map((tool) => ({
            ...tool,
            inputSchema: taskToolJsonSchema(tool.name),
          }));
        const answered = (made: Effect.Effect<TaskToolDone, TaskToolRefused>) =>
          made.pipe(
            Effect.match({
              onFailure: (refused) => ({ text: taskToolText(refused), refused: true }),
              onSuccess: (done) => ({ text: taskToolText(done), refused: false }),
            }),
            Effect.catchCause((cause) =>
              Effect.logError("A Task tool call failed", cause).pipe(
                Effect.as({ text: COULD_NOT_RECORD, refused: true }),
              ),
            ),
            Effect.provideContext(context),
          );
        const notOffered = (name: string) =>
          refuse("unknown-tool", `${name} is not offered in this session. Use the tools you were given.`);

        const forTurn = (caller: TaskToolCaller, only?: ReadonlyArray<TaskToolName>): HubTools => ({
          tools: offered(only),
          call: (name, input) =>
            answered(
              only === undefined || (isTaskToolName(name) && only.includes(name))
                ? call(caller, name, input)
                : notOffered(name),
            ),
        });

        const forChat = (turn: ChatTurn) =>
          Effect.gen(function* () {
            const chat = makeChatResolver(tasks, turn);
            // The Attempt this turn started on its Task, known once the call that started it commits.
            let attemptId: AttemptId | null = null;
            const source: CallSource = {
              turn: { turn_reply: turn.messageId },
              resolve: (name, at) => chat.resolve(name, at, attemptId),
            };
            const end = (outcome: Parameters<ChatTaskTurn["end"]>[0], sessionId: string | null) =>
              Effect.gen(function* () {
                if (attemptId === null) return;
                const at = DateTime.formatIso(yield* DateTime.now);
                const ended = yield* tasks
                  .updateAttempt(attemptId, { state: outcome, at, ...(sessionId === null ? {} : { sessionId }) })
                  .pipe(Effect.option);
                if (Option.isSome(ended)) yield* announce(ended.value.entries);
              }).pipe(
                Effect.catchCause((cause) => Effect.logWarning("Could not end a chat turn's Attempt", cause)),
                Effect.provideContext(context),
              );
            const hubTools: HubTools = {
              tools: offered(undefined),
              call: (name, input) =>
                answered(
                  callFrom(turn.agentId, source, name, input, (resolved) => {
                    if (resolved.attemptId !== null) attemptId = resolved.attemptId;
                  }),
                ),
            };
            return { hubTools, briefing: yield* chat.briefing, end } satisfies ChatTaskTurn;
          });

        return TaskTools.of({ call, forTurn, forChat });
      }),
    );
}
