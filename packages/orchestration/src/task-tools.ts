import {
  EventPublisher,
  FolderChecks,
  HobbotsRepository,
  type HubTools,
  TaskRepository,
  TaskToolCalls,
  type TaskToolOutcome,
} from "@hobbots/agents";
import {
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
import {
  type CallScope,
  DEFAULT_TASK_TOOL_LIMITS,
  makeAuthorityOf,
  makeCapacity,
  refuse,
  type TaskToolCaller,
  type TaskToolLimits,
} from "./call-scope.ts";
import { makeDelegating } from "./delegating.ts";
import { makePlanning } from "./planning.ts";

type ToolHandler = (scope: CallScope, input: never) => Effect.Effect<TaskToolOutcome, TaskToolRefused>;

const describe = (error: Schema.SchemaError) => error.message.split("\n").slice(0, 6).join("\n");

const COULD_NOT_RECORD = "Hobbots could not record this call, so it did not happen. Try again with the same key.";

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
    /** The tools a turn on the caller's Task offers its runtime. */
    readonly forTurn: (caller: TaskToolCaller) => HubTools;
  }
>()("@hobbots/orchestration/TaskTools") {
  static readonly layer = (limits: TaskToolLimits = DEFAULT_TASK_TOOL_LIMITS) =>
    Layer.effect(
      TaskTools,
      Effect.gen(function* () {
        const tasks = yield* TaskRepository;
        const ledger = yield* TaskToolCalls;
        const publisher = yield* EventPublisher;
        const capacity = yield* makeCapacity(limits);
        const authorityOf = yield* makeAuthorityOf;
        const folderChecks = yield* FolderChecks;
        const hobs = yield* HobbotsRepository;
        const handlers: Record<TaskToolName, ToolHandler> = {
          ...makePlanning({ tasks, capacity, limits }),
          ...makeDelegating({ tasks, capacity, limits, authorityOf, folderChecks, hobs }),
          ...makeAsking({ tasks }),
        };

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

        const call = (caller: TaskToolCaller, name: string, raw: unknown) =>
          Effect.gen(function* () {
            if (!isTaskToolName(name)) return yield* refuse("unknown-tool", `Hobbots has no ${name} tool.`);
            const input = yield* Schema.decodeUnknownEffect(TaskToolInputs[name])(raw).pipe(
              Effect.mapError((error) => new TaskToolRefused({ reason: "invalid-input", message: describe(error) })),
            );
            const { key, ...rest } = input;
            const at = DateTime.formatIso(yield* DateTime.now);
            const outcome = yield* ledger.once(
              { agentId: caller.agentId, key, tool: name, input: stableJson(rest), at },
              Effect.flatMap(scopeOf(caller, at), (scope) => handlers[name](scope, rest as never)),
            );
            if (outcome.entries.length > 0) yield* publisher.publish(outcome.entries);
            return outcome.done;
          });

        const forTurn = (caller: TaskToolCaller): HubTools => ({
          tools: TASK_TOOLS.map((tool) => ({ ...tool, inputSchema: taskToolJsonSchema(tool.name) })),
          call: (name, input) =>
            call(caller, name, input).pipe(
              Effect.match({
                onFailure: (refused) => ({ text: taskToolText(refused), refused: true }),
                onSuccess: (done) => ({ text: taskToolText(done), refused: false }),
              }),
              Effect.catchCause((cause) =>
                Effect.logError("A Task tool call failed", cause).pipe(
                  Effect.as({ text: COULD_NOT_RECORD, refused: true }),
                ),
              ),
            ),
        });

        return TaskTools.of({ call, forTurn });
      }),
    );
}
