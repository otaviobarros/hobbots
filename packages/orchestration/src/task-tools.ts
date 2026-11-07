import {
  type ChatTaskTurn,
  type ChatTurn,
  callScope,
  EventPublisher,
  FolderChecks,
  HobbotsRepository,
  type HubCallStep,
  type HubTools,
  hubToolOffer,
  joinHubTools,
  makeRedactor,
  type Redactor,
  SecretRedaction,
  TaskRepository,
  TaskToolCalls,
  type TaskToolOutcome,
  type ToolAccess,
  type TurnApprovals,
} from "@hobbots/agents";
import {
  type AttemptId,
  type CarriedItem,
  carriedWith,
  type EventEnvelope,
  isTaskToolName,
  stableJson,
  TASK_TOOLS,
  type TaskId,
  type TaskToolDone,
  TaskToolInputs,
  type TaskToolName,
  TaskToolRefused,
  type TurnEnding,
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
  makeHobRoom,
  refuse,
  type TaskToolCaller,
  type TaskToolLimits,
} from "./call-scope.ts";
import { makeCharmRecords } from "./charm-records.ts";
import { makeChatResolver, type ResolvedCaller } from "./chat-turns.ts";
import { makeDelegating } from "./delegating.ts";
import { makeDeliveryCheck } from "./delivery.ts";
import { flagIdleQuest } from "./empty-quests.ts";
import { makeHeldCommits } from "./held-commits.ts";
import { makeLeading } from "./leading.ts";
import { makePlanning } from "./planning.ts";
import { routineReply, waitingForYou } from "./quiet-replies.ts";
import { makeRefusals, showRefusal } from "./refusals.ts";
import { TaskSignal } from "./signal.ts";
import { endTurn, type TurnEndDeps } from "./turn-end.ts";
import { makeSettle, makeWrapUp } from "./wrap-up.ts";

type ToolHandler = (scope: CallScope, input: never) => Effect.Effect<TaskToolOutcome, TaskToolRefused>;

const describe = (error: Schema.SchemaError) => error.message.split("\n").slice(0, 6).join("\n");

const COULD_NOT_RECORD = "Hobbots could not record this call, so it did not happen. Try again with the same key.";

/**
 * Who a call comes from: a turn on a known Task, or a chat turn whose Task is found, or started,
 * inside the call's own transaction. `scope` tells a retried key from another work's.
 */
interface CallSource {
  /** The work the call's key belongs to now (#660), from `callScope`: a call can start the turn's Task. */
  readonly scope: () => string;
  /** Another scope a retry of the key is found in: a chat turn's reply. */
  readonly also?: string;
  /** The backpack claims the turn holds, which fence each of its calls (ADR 019). */
  readonly fence: ReadonlyArray<CarriedItem>;
  /**
   * The committed Task the turn works on, when one is known before the call: what a refusal is
   * recorded on when the call never reached its own Task, as one refused before it is decided.
   */
  readonly taskId: () => TaskId | null;
  readonly resolve: (name: TaskToolName, at: string) => Effect.Effect<ResolvedCaller, TaskToolRefused>;
  /** The backpack items the turn's earlier calls showed it, by id, which it carries from then on (#662). */
  readonly shown: Map<string, CarriedItem>;
}

/** The caller, carrying what the turn's earlier calls showed it as well, a held claim winning. */
const withShown = (caller: TaskToolCaller, shown: ReadonlyMap<string, CarriedItem>): TaskToolCaller =>
  shown.size === 0 ? caller : { ...caller, carried: carriedWith(caller.carried ?? [], shown.values()) };

/** What a session's Charm calls run under: the hob's access now, its redactor, and who answers an Ask. */
export interface SessionCharms {
  /** The Attempt the session runs as: a memory save it makes settles in that Attempt's session (#1049). */
  readonly attemptId: AttemptId;
  readonly currentAccess: Effect.Effect<ToolAccess | null>;
  readonly redactor: Redactor;
  readonly approvals: TurnApprovals | null;
}

/**
 * The Hobbots tools for Tasks and Quests (ADR 018). Every call is checked by the hub: who may make
 * it, depth, open-Task limits, cycles and authority. A refused call writes nothing and says why;
 * a call with a key already used returns its first result. A turn that carries backpack items
 * under claims is fenced by them: once any claim is lost, its calls are refused (ADR 019).
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
     * The tools a session working the caller's Task outside any chat offers, a party member's or a
     * step's: those of `forTurn`, and the local Git and Charm tools its access opens, read at its
     * start, as a chat turn's are (#699). A Charm call is keyed in the Task's work and recorded on
     * the Task, under `turn.currentAccess`, which every Delegation above it narrows.
     */
    readonly forSession: (
      caller: TaskToolCaller,
      turn: SessionCharms,
      only?: ReadonlyArray<TaskToolName>,
    ) => Effect.Effect<HubTools>;
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
        const hobRoom = yield* makeHobRoom(limits);
        const authority = yield* makeAuthorityOf(separator);
        const folderChecks = yield* FolderChecks;
        const hobs = yield* HobbotsRepository;
        const wrapUp = yield* makeWrapUp;
        const delivered = yield* makeDeliveryCheck;
        const settle = yield* makeSettle;
        // A lead's commit of a member's open work is held, whichever runtime makes it (#742).
        const heldCommit = yield* makeHeldCommits;
        const handlers: Record<TaskToolName, ToolHandler> = {
          ...makePlanning({
            tasks,
            capacity,
            limits,
            wrapUp,
            delivered,
            folderChecks,
            authority: authority.of,
            separator,
          }),
          ...makeDelegating({ tasks, capacity, limits, authority, folderChecks, hobs, separator }),
          ...makeAsking({ tasks, hobs }),
          ...makeLeading({ tasks }),
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
        ) => {
          // Set inside the call's transaction; read only once it has committed, or was refused.
          const seen: { resolved: ResolvedCaller | null } = { resolved: null };
          // A refused call's Task, unless the call started it: that Task was rolled back with the call.
          const taskOf = () =>
            seen.resolved === null || seen.resolved.entries.some((entry) => entry.type === "TaskCreated")
              ? source.taskId()
              : seen.resolved.caller.taskId;
          return Effect.gen(function* () {
            if (!isTaskToolName(name)) return yield* refuse("unknown-tool", `Hobbots has no ${name} tool.`);
            const input = yield* Schema.decodeUnknownEffect(TaskToolInputs[name])(raw).pipe(
              Effect.mapError((error) => new TaskToolRefused({ reason: "invalid-input", message: describe(error) })),
            );
            const { key, ...rest } = input;
            // What the turn changed is on the record before the completion reads it (#586), and
            // before a delegation, so a lead's earlier changes are not taken for its member's (#658).
            if (name === "complete_task" || name === "delegate_task") yield* settle(rest, source.taskId());
            const at = DateTime.formatIso(yield* DateTime.now);
            const outcome = yield* ledger.once(
              {
                agentId,
                scope: source.scope(),
                ...(source.also === undefined ? {} : { also: source.also }),
                key,
                tool: name,
                input: stableJson(rest),
                at,
                fence: source.fence,
              },
              Effect.gen(function* () {
                const resolved = yield* source.resolve(name, at);
                seen.resolved = resolved;
                const scope = yield* scopeOf(withShown(resolved.caller, source.shown), at);
                const made = yield* handlers[name](scope, rest as never);
                // A call that starts the turn's Task takes the turn's calls into that Task's work.
                const started = resolved.entries.some((entry) => entry.type === "TaskCreated");
                return {
                  ...made,
                  entries: [...resolved.entries, ...made.entries],
                  ...(started ? { scope: callScope.task(resolved.caller.taskId) } : {}),
                };
              }),
            );
            if (seen.resolved !== null) committed(seen.resolved);
            for (const item of outcome.shown ?? []) source.shown.set(item.itemId, item);
            // Committed already: a client that misses the announcement replays it from the journal.
            if (outcome.entries.length > 0) yield* announce(outcome.entries);
            return outcome.done;
          }).pipe(refusals.recorded({ agentId, scope: source.scope, tool: name, raw, taskOf }));
        };

        const announce = (entries: ReadonlyArray<EventEnvelope>) =>
          Effect.gen(function* () {
            yield* publisher
              .publish(entries)
              .pipe(Effect.catchCause((cause) => Effect.logWarning("Could not announce a Task tool call", cause)));
            if (Option.isSome(signal)) yield* signal.value.notify;
          });
        // Without the hub's redactor, secret shapes are still redacted.
        const redactor = Option.getOrElse(yield* Effect.serviceOption(SecretRedaction), () => makeRedactor());
        const refusals = makeRefusals(ledger, announce, redactor);
        const charmRecords = makeCharmRecords(tasks, refusals, announce);

        const call = (caller: TaskToolCaller, name: string, raw: unknown, shown = new Map<string, CarriedItem>()) =>
          callFrom(
            caller.agentId,
            {
              scope: () => callScope.task(caller.taskId),
              fence: caller.carried ?? [],
              taskId: () => caller.taskId,
              resolve: () => Effect.succeed({ caller, entries: [], attemptId: null }),
              shown,
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
        const answered = (made: Effect.Effect<TaskToolDone, TaskToolRefused>, step?: HubCallStep) =>
          made.pipe(
            Effect.match({
              onFailure: (refused) => {
                showRefusal(step, refused.message);
                return { text: taskToolText(refused), refused: true };
              },
              onSuccess: (done) => ({ text: taskToolText(done), refused: false }),
            }),
            Effect.catchCause((cause) =>
              Effect.logError("A Task tool call failed", cause).pipe(
                Effect.map(() => {
                  showRefusal(step, COULD_NOT_RECORD);
                  return { text: COULD_NOT_RECORD, refused: true };
                }),
              ),
            ),
            Effect.provideContext(context),
          );
        const notOffered = (name: string) =>
          refuse("unknown-tool", `${name} is not offered in this session. Use the tools you were given.`);

        const forTurn = (caller: TaskToolCaller, only?: ReadonlyArray<TaskToolName>): HubTools => {
          const shown = new Map<string, CarriedItem>();
          const refused = (name: string, input: unknown) =>
            notOffered(name).pipe(
              refusals.recorded({
                agentId: caller.agentId,
                scope: () => callScope.task(caller.taskId),
                tool: name,
                raw: input,
                taskOf: () => caller.taskId,
              }),
            );
          return {
            tools: offered(only),
            call: (name, input, step) =>
              answered(
                only === undefined || (isTaskToolName(name) && only.includes(name))
                  ? call(caller, name, input, shown)
                  : refused(name, input),
                step,
              ),
            holdsCommit: (cwd) => heldCommit(caller.taskId, cwd),
          };
        };

        const forChat = (turn: ChatTurn) =>
          Effect.gen(function* () {
            const chat = makeChatResolver(tasks, hobRoom, turn);
            // The Attempt this turn started on its Task, known once the call that started it commits.
            let attemptId: AttemptId | null = null;
            // The committed Task the turn works on: the one it was briefed on, then one a call of its committed.
            const briefed = yield* chat.briefing;
            let known: TaskId | null = yield* chat.workingOn;
            const source: CallSource = {
              scope: () => (known === null ? callScope.reply(turn.messageId) : callScope.task(known)),
              also: callScope.reply(turn.messageId),
              fence: turn.holding ?? [],
              taskId: () => known,
              resolve: (name, at) => chat.resolve(name, at, attemptId),
              shown: new Map(),
            };
            // The questions waiting for you as the turn starts, so its end knows one it brought you (#1006).
            const askedBefore = known === null ? [] : waitingForYou(yield* tasks.readTree(known));
            // A turn briefed on its Task works on it as an Attempt of its own from the start.
            const begun = yield* chat.begin(DateTime.formatIso(yield* DateTime.now));
            // The Task the turn's Attempt is on, which it ends on whatever Task a later call names.
            let attemptOn: TaskId | null = null;
            if (begun !== null) {
              attemptId = begun.attemptId;
              attemptOn = known;
              yield* announce(begun.entries);
            }
            // The Task you asked for completes only by complete_task, so it is never blocked here.
            const ended: TurnEndDeps = {
              tasks,
              attempt: (change) =>
                change.pipe(
                  Effect.tap((committed) => announce(committed.entries)),
                  Effect.map((committed) => committed.value),
                  Effect.tapError((error) => Effect.logDebug("A chat turn's end was refused", error)),
                  Effect.option,
                ),
            };
            const end = (ending: TurnEnding, sessionId: string | null, policyVersion: string | null) =>
              Effect.gen(function* () {
                if (attemptId === null || attemptOn === null) return;
                const at = DateTime.formatIso(yield* DateTime.now);
                const { completed } = yield* endTurn(ended, {
                  runner: "root",
                  taskId: attemptOn,
                  attemptId,
                  ending,
                  carried: [],
                  sessionId,
                  policyVersion,
                  ...(begun === null ? {} : { was: begun.was }),
                  at,
                });
                // A reply that left its Quest with nothing moving it wakes its lead, or stalls it (#1081).
                if (!completed && ending._tag === "Replied") {
                  const carried = new Set<string>((turn.holding ?? []).map((each) => each.itemId));
                  yield* flagIdleQuest(ended, attemptOn, carried, at);
                }
              }).pipe(
                Effect.catchCause((cause) => Effect.logWarning("Could not end a chat turn's Attempt", cause)),
                Effect.provideContext(context),
              );
            const hubTools: HubTools = {
              tools: offered(undefined),
              call: (name, input, step) =>
                answered(
                  callFrom(turn.agentId, source, name, input, (resolved) => {
                    if (resolved.attemptId !== null) {
                      attemptId = resolved.attemptId;
                      attemptOn = resolved.caller.taskId;
                    }
                    if (resolved.readOnly !== true) known = resolved.caller.taskId;
                  }),
                  step,
                ),
              holdsCommit: (cwd) => heldCommit(known, cwd),
            };
            return {
              hubTools,
              briefing: briefed?.text ?? null,
              told: briefed?.told ?? null,
              end,
              workingOn: chat.workingOn,
              scope: source.scope,
              recordCharms: charmRecords({ agentId: turn.agentId, scope: source.scope, taskOf: () => known }),
              attempt: Effect.sync(() => attemptId),
              quiet: Effect.suspend(() =>
                turn.promptId != null || known === null
                  ? Effect.succeed(false)
                  : Effect.map(tasks.readTree(known), (tree) => routineReply(tree, askedBefore)),
              ),
              workIn: Effect.suspend(() =>
                known === null
                  ? Effect.succeed(null)
                  : Effect.map(tasks.readTree(known), (tree) =>
                      Option.isNone(tree)
                        ? null
                        : (tree.value.quests.find((quest) => quest.taskId === known)?.limits.folders ?? null),
                    ),
              ),
            } satisfies ChatTaskTurn;
          });

        /**
         * The Charms a session outside any chat offers: none of their writes. A write whose answer
         * is lost waits for you to settle it on the reply step it showed as (ADR 020), and such a
         * session has no reply, so its writes stay with the lead's chat until it does. A call to one
         * is refused as a tool the session does not offer, and a `git push` is decided as a push.
         */
        const withoutSteering = (charms: HubTools | null): HubTools | null =>
          charms === null || charms.tools.length === 0 ? null : { tools: charms.tools, call: charms.call };
        // Without Charms or local Git tools, a session offers only its Task tools.
        const charmsFor = yield* hubToolOffer;
        const forSession = (caller: TaskToolCaller, turn: SessionCharms, only?: ReadonlyArray<TaskToolName>) =>
          Effect.gen(function* () {
            const scope = () => callScope.task(caller.taskId);
            const charms = withoutSteering(
              yield* charmsFor(
                {
                  ...turn,
                  agentId: caller.agentId,
                  threadId: null,
                  messageId: null,
                  scope,
                },
                { writes: false },
              ),
            );
            const recorded = charmRecords({ agentId: caller.agentId, scope, taskOf: () => caller.taskId })(charms);
            const tools = forTurn(caller, only);
            return (
              joinHubTools([
                { owner: "the Task tools", tools },
                { owner: "the hub's other tools", tools: recorded },
              ]) ?? tools
            );
          });

        return TaskTools.of({ call, forTurn, forSession, forChat });
      }),
    );
}
