import {
  AgentNotFound,
  HobUnavailable,
  type InvalidHob,
  MessageNotQueued,
  ReplyNotResumable,
  ThreadArchived,
  type ThreadArchiveRefusal,
  ThreadArchiveRefused,
  ThreadNotFound,
} from "@hobbots/api";
import {
  type Agent,
  type AgentConfiguration,
  type AgentId,
  type Brain,
  type Committed,
  DEFAULT_THREAD_TITLE,
  isInProgress,
  isResumable,
  Message,
  MessageId,
  type MessageStatus,
  MessageTransitions,
  QueuedMessageTransitions,
  RUNTIME_NAMES,
  type RuntimeKind,
  sameBrain,
  systemInstructions,
  Thread,
  ThreadCheckpoint,
  ThreadId,
  titleFromPrompt,
} from "@hobbots/domain";
import { Context, DateTime, Effect, Fiber, FiberMap, Layer, Option, Ref, Semaphore, Stream } from "effect";
import { HobAdmission } from "./admission.ts";
import { ApprovalService } from "./approvals.ts";
import { buildBriefing } from "./briefing.ts";
import { CharmTools, combineHubTools } from "./charms.ts";
import { type CarriedEnd, type CarriedWork, Continuations } from "./continuations.ts";
import { checkRuntimeBrain } from "./hobs.ts";
import { EventPublisher, ToolLogs } from "./ports.ts";
import { HobbotsRepository } from "./repository.ts";
import { type RuntimeEvent, runtimeAdapters, type ToolAccess, type ToolStartedEvent } from "./runtime.ts";
import { makeRedactor, redactEvent, SecretRedaction } from "./secrets.ts";
import { nextSteps, replyStepId, uncertainCalls } from "./steps.ts";
import { type ChatTurnOutcome, TaskTurns } from "./task-turns.ts";
import { keepToolOutput } from "./tool-output.ts";
import { accessNow, HobTools, narrows } from "./tools.ts";

interface Reply {
  readonly current: Ref.Ref<Message>;
  readonly lock: Semaphore.Semaphore;
  /** How many steps the reply had from earlier turns when Continue resumed it; this turn's come after. */
  readonly stepsFrom: number;
  /** The text the reply already had when Continue resumed it; the runtime's final text comes after it. */
  readonly prefix: string;
  /** Whether the turn carries work that needs the hob, so a stop holds it back until you write again. */
  readonly carries: boolean;
}

/** Backpack items a turn carries (ADR 019): told to it, held under its claims, and accepted with its session. */
type Carry = Pick<CarriedWork, "holding" | "accepted" | "routineOnly">;

/** What a turn carries when it carries no backpack items. */
const NOTHING_CARRIED: Carry = { holding: [], accepted: () => Effect.void, routineOnly: true };

/** How a turn starts: its reply's id, what it carries, and whether its end starts what waits next. */
interface TurnStart {
  readonly replyId?: MessageId;
  /** Told after the briefing, as Hobbots' own words: the work that rides along your message. */
  readonly context?: string | null;
  readonly carry?: Carry | null;
  /** False when whoever started the turn starts what waits next, once it has settled the turn's work. */
  readonly drain?: boolean;
}

/** How much of a cut-off reply the runtime is shown when asked to continue it. */
const CONTINUE_CONTEXT = 4_000;

/**
 * The prompt that resumes a reply that ended early, so the runtime picks up where it left off. Tool
 * calls the reply left uncertain are named, so none is run again before it is checked (EX-004).
 */
const continuePrompt = (reply: Message) => {
  const uncertain = uncertainCalls(reply.steps);
  return [
    "Your previous reply was cut off before it finished. It ends with this text:",
    "",
    reply.content.slice(-CONTINUE_CONTEXT),
    "",
    ...(uncertain === null ? [] : [uncertain, ""]),
    "Continue from exactly where it stops. Do not repeat what is already written.",
  ].join("\n");
};

const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

/** How a turn ended, for the Attempt it may have started on a Task: a reply still running was interrupted. */
const turnOutcome = (status: MessageStatus): ChatTurnOutcome =>
  status === "complete" ? "completed" : status === "failed" || status === "limited" ? "failed" : "interrupted";

/** The brain a thread's turn thinks with: the thread's own, else the hob's configuration's. */
const brainFor = (thread: Thread, config: AgentConfiguration): Brain =>
  thread.brain ?? { runtime: config.runtime, model: config.model, effort: config.effort };

const sameOwnBrain = (a: Brain | null, b: Brain | null) => (a === null || b === null ? a === b : sameBrain(a, b));

/**
 * The messages a runtime's session missed (ADR 017): everything after the last one it saw, and that
 * one too when another brain continued it since. Without a record of what it saw, everything after
 * its own latest reply.
 */
const missedBy = (runtime: RuntimeKind, seenThrough: string | null, before: ReadonlyArray<Message>) => {
  const seen = before.findIndex((m) => m.id === seenThrough);
  if (seen !== -1) return before.slice(before[seen]?.runtime === runtime ? seen + 1 : seen);
  const own = before.findLastIndex((m) => m.role === "assistant" && m.runtime === runtime);
  return before.slice(own + 1);
};

export class ChatService extends Context.Service<
  ChatService,
  {
    readonly createThread: (agentId: AgentId) => Effect.Effect<Thread, AgentNotFound | HobUnavailable>;
    /** Starts a turn, or queues the message while the thread's reply runs (assistantMessage is then null). */
    readonly sendPrompt: (
      threadId: ThreadId,
      content: string,
    ) => Effect.Effect<
      { userMessage: Message; assistantMessage: Message | null },
      ThreadNotFound | HobUnavailable | ThreadArchived
    >;
    readonly removeQueued: (
      threadId: ThreadId,
      messageId: MessageId,
    ) => Effect.Effect<void, ThreadNotFound | MessageNotQueued>;
    /** Stops the thread's running reply, if any, and starts this queued message once the turn has ended. */
    readonly sendNow: (
      threadId: ThreadId,
      messageId: MessageId,
    ) => Effect.Effect<void, ThreadNotFound | MessageNotQueued>;
    /**
     * Asks the thread's current turn to stop and returns once the request is recorded: the reply shows
     * as stopping, then as stopped when the runtime confirms the turn ended. Asking again, or with no
     * turn in progress, changes nothing.
     */
    readonly stop: (threadId: ThreadId) => Effect.Effect<void, ThreadNotFound>;
    /**
     * Continue: resumes a reply that was cut off or ended by the provider's limit, in place. Only the
     * thread's latest message can be continued, while its hob is active and no other turn runs.
     */
    readonly continueReply: (
      threadId: ThreadId,
      messageId: MessageId,
    ) => Effect.Effect<Message, ThreadNotFound | HobUnavailable | ReplyNotResumable | ThreadArchived>;
    /** Stops every turn the hob has in progress and waits until each has ended (stopped if the user had asked, otherwise interrupted). */
    readonly interruptAgent: (agentId: AgentId) => Effect.Effect<void>;
    /**
     * Stops, and waits for, every running turn of the hob (or of every hob) whose tools the current
     * policy narrows: a folder removed, the tools taken away, or an operation's answer narrowed
     * (PE-008). Call it once a change to the policy is saved.
     */
    readonly reviewAuthority: (agentId?: AgentId) => Effect.Effect<void>;
    /**
     * Switches the thread to its own brain, or back to the hob's with null (ADR 017), from its next
     * turn. A brain the same as the hob's follows the hob. Refused for a retired hob, a runtime the
     * hub cannot run, or a model or effort the runtime does not offer.
     */
    readonly setBrain: (
      threadId: ThreadId,
      brain: Brain | null,
    ) => Effect.Effect<Thread, ThreadNotFound | HobUnavailable | InvalidHob | ThreadArchived>;
    /**
     * Refuses a brain switch the thread cannot take now: its hob retired or the thread archived.
     * Reads without the hob's lock: call it while holding the lock (`HobService.updateThen`).
     */
    readonly checkBrainSwitch: (
      threadId: ThreadId,
    ) => Effect.Effect<void, ThreadNotFound | HobUnavailable | ThreadArchived>;
    /**
     * Clears the thread's own brain, so it follows its hob again. Takes no hob lock: call it while
     * holding the lock, after `checkBrainSwitch`.
     */
    readonly followHob: (threadId: ThreadId) => Effect.Effect<Thread, ThreadNotFound>;
    /**
     * Archives the thread, which then takes no new messages until it is restored. Refused while a
     * reply runs or waits in its queue, while an approval waits, or when its hob is retired.
     * Archiving an archived thread returns it unchanged.
     */
    readonly archive: (threadId: ThreadId) => Effect.Effect<Thread, ThreadNotFound | ThreadArchiveRefused>;
    /** Restores an archived thread, unless its hob is retired. Restoring a live thread returns it unchanged. */
    readonly restore: (threadId: ThreadId) => Effect.Effect<Thread, ThreadNotFound | ThreadArchiveRefused>;
    /** Starts the hob's queued messages and the work waiting in its backpack, in threads with no turn running, as when it wakes. */
    readonly drainAgent: (agentId: AgentId) => Effect.Effect<void>;
    /**
     * Starts what waits in the thread, if no turn runs there: your queued message first, with any
     * backpack work riding along, else a continuation for that work (ADR 019). Called when work
     * arrives for the thread's hob.
     */
    readonly wake: (threadId: ThreadId) => Effect.Effect<void>;
    /**
     * Threads with a turn in progress in this process, until its runtime has exited. Each change is
     * announced as the transient `TurnStarted` or `TurnEnded`, published once it has happened.
     */
    readonly activeThreads: Effect.Effect<ReadonlyArray<ThreadId>>;
    /** The replies still streaming or stopping, with all the text held in memory so far. */
    readonly streamingReplies: Effect.Effect<ReadonlyArray<Message>>;
  }
>()("@hobbots/agents/ChatService") {
  static readonly layer = Layer.effect(
    ChatService,
    Effect.gen(function* () {
      const repo = yield* HobbotsRepository;
      const bus = yield* EventPublisher;
      const adapters = yield* runtimeAdapters;
      const admission = yield* HobAdmission;
      const hobTools = yield* HobTools;
      // Without approvals, a call the policy answers Ask for is refused, as in hubs and tests that ask nothing.
      const approvals = yield* Effect.serviceOption(ApprovalService);
      // Without the hub's redactor, secret shapes are still redacted.
      const redactor = Option.getOrElse(yield* Effect.serviceOption(SecretRedaction), () => makeRedactor());
      // Without a log store, a long tool output keeps only its start and end.
      const toolLogs = yield* Effect.serviceOption(ToolLogs);
      // Without Task work, turns offer no Task tools and hobs run no steps.
      const taskTurns = yield* Effect.serviceOption(TaskTurns);
      // Without Charms, turns offer only the Task tools.
      const charms = yield* Effect.serviceOption(CharmTools);
      // Without a backpack, a thread starts only your queued messages.
      const continuations = yield* Effect.serviceOption(Continuations);
      const turns = yield* FiberMap.make<ThreadId>();
      const scope = yield* Effect.scope;
      // The reply each running turn is writing, so a stop request can reach it.
      const replies = new Map<ThreadId, Reply>();
      // Threads with a turn running or just ended and not yet drained. In-process, as turns are;
      // the queue itself is the stored queued messages.
      const busy = new Set<ThreadId>();
      // The queued message Send now picked to start next in each thread.
      const chosen = new Map<ThreadId, MessageId>();
      // Threads whose turn carrying backpack work you stopped: the work waits for your next message
      // there, or for the hob to wake, instead of starting again on its own. In memory: a restart
      // delivers it again.
      const holdBack = new Set<ThreadId>();
      // Busy threads woken meanwhile, as when work arrives for their hob: once the thread is freed,
      // what waits there is looked at again, so work that arrived after the dispatcher looked waits
      // no longer than that.
      const rewake = new Set<ThreadId>();

      const findThread = (threadId: ThreadId) =>
        repo.findThread(threadId).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.fail(new ThreadNotFound({ threadId })),
              onSome: Effect.succeed,
            }),
          ),
        );

      // Only an active hob takes new work; a paused or retired hob's threads stay readable.
      const requireActive = (agent: Agent) =>
        agent.status === "active"
          ? Effect.void
          : Effect.fail(new HobUnavailable({ agentId: agent.id, status: agent.status }));

      // An archived thread is read-only until it is restored.
      const requireLive = (thread: Thread) =>
        thread.archivedAt === null
          ? Effect.void
          : Effect.fail(new ThreadArchived({ threadId: thread.id, archivedAt: thread.archivedAt }));

      // Writes journal their events in the same transaction (ADR 013); the bus announces them once
      // committed. Each returns what it stored, with its revision.
      const announce = <A>(committed: Committed<A>) => Effect.as(bus.publish(committed.entries), committed.value);
      const saveThread = (thread: Thread) => repo.upsertThread(thread).pipe(Effect.flatMap(announce));
      const saveMessage = (message: Message) => repo.upsertMessage(message).pipe(Effect.flatMap(announce));
      // Changes the thread as it is stored now, one change at a time, so a turn recording its session
      // and a brain switch never overwrite each other. `change` returns null to leave it as it is.
      const threadWrites = yield* Semaphore.make(1);
      const changeThread = (threadId: ThreadId, change: (thread: Thread) => Thread | null) =>
        Semaphore.withPermit(
          threadWrites,
          Effect.gen(function* () {
            const stored = yield* repo.findThread(threadId);
            if (Option.isNone(stored)) return stored;
            const next = change(stored.value);
            return Option.some(next === null ? stored.value : yield* saveThread(next));
          }),
        );

      // A previous process may have died mid-turn; those turns cannot resume. A reply the user had
      // asked to stop is stopped; any other is interrupted.
      for (const message of yield* repo.listUnfinishedMessages) {
        const next = MessageTransitions.interrupt(message);
        if (next instanceof Message) yield* saveMessage(next);
      }

      // A queued message's start and removal write, then announce the change once it is committed (CH-008).
      const saveStarted = (message: Message, reply: Message) =>
        repo.startQueuedMessage(message, reply).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.succeed(null),
              onSome: (committed) => announce(committed).pipe(Effect.map((saved) => saved.reply)),
            }),
          ),
        );
      const saveRemoved = (threadId: ThreadId, messageId: MessageId) =>
        repo.removeQueuedMessage(threadId, messageId).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.succeed(false),
              onSome: (committed) => Effect.as(announce(committed), true),
            }),
          ),
        );

      // Status is read under the hob's lock, so a pause or retirement cannot slip in before the thread is saved.
      const createThread = Effect.fn("ChatService.createThread")(function* (agentId: AgentId) {
        return yield* admission.withHob(
          agentId,
          Effect.gen(function* () {
            const agent = yield* repo.findAgent(agentId);
            if (Option.isNone(agent)) return yield* new AgentNotFound({ agentId });
            yield* requireActive(agent.value);
            const now = yield* nowIso;
            const thread = new Thread({
              id: ThreadId.make(crypto.randomUUID()),
              agentId,
              title: DEFAULT_THREAD_TITLE,
              createdAt: now,
              updatedAt: now,
            });
            return yield* saveThread(thread);
          }),
        );
      });

      // Applies a domain transition to a running reply and runs `after` with the result. The lock keeps
      // the turn and a stop request from saving out of order. Finished replies reject changes, so late
      // runtime events and repeated stops are ignored.
      const transition = <A>(
        reply: Reply,
        f: (message: Message) => Message | unknown,
        after: (next: Message) => Effect.Effect<A>,
      ) =>
        Semaphore.withPermit(
          reply.lock,
          Effect.gen(function* () {
            const next = f(yield* Ref.get(reply.current));
            if (!(next instanceof Message)) return Option.none<A>();
            yield* Ref.set(reply.current, next);
            return Option.some(yield* after(next));
          }),
        );

      // Claude Code keeps a resumed session's first instructions, so a turn whose session may follow
      // others carries them. Which a session follows is not stored: a stopped or failed turn may or may
      // not have delivered its own, and threads from before #164 never received theirs. So a thread
      // whose replies all ran on the current instructions needs nothing, and any other carries them.
      const instructionsChanged = (thread: Thread, runtime: RuntimeKind, agent: Agent, instructions: string) =>
        Effect.gen(function* () {
          if (!thread.sessions.some((session) => session.runtime === runtime)) return false;
          const versions = new Set(
            (yield* repo.listMessages(thread.id)).flatMap((m) =>
              m.role === "assistant" && m.configVersion !== null ? [m.configVersion] : [],
            ),
          );
          for (const version of versions) {
            const config = yield* repo.findAgentConfig(agent.id, version);
            if (Option.isNone(config) || systemInstructions(agent.name, config.value) !== instructions) return true;
          }
          return false;
        });

      // What the turn's session missed, told ahead of the prompt (ADR 017), built from the stored
      // transcript without asking the brain the thread left. `before` is the transcript before the
      // turn's own prompt and reply. `switched` when the reply itself moves from another brain, as on
      // Continue. A summary made anew is stored for the next handoff.
      const brief = (thread: Thread, runtime: RuntimeKind, before: ReadonlyArray<Message>, switched: boolean) =>
        Effect.gen(function* () {
          const session = thread.sessions.find((s) => s.runtime === runtime);
          const missed = session === undefined ? before : missedBy(runtime, session.seenThrough, before);
          // Only a switch needs one: a session is told what other brains wrote that it did not see.
          const others = missed.some((m) => m.role === "assistant" && m.runtime !== null && m.runtime !== runtime);
          if (!switched && !others) return null;
          const briefing = buildBriefing({
            kind: session === undefined ? "new" : "resumed",
            messages: missed,
            checkpoint: session === undefined ? Option.getOrNull(yield* repo.findCheckpoint(thread.id)) : null,
          });
          if (briefing?.checkpoint) {
            yield* repo.saveCheckpoint(
              new ThreadCheckpoint({ threadId: thread.id, ...briefing.checkpoint, createdAt: yield* nowIso }),
            );
          }
          return briefing?.text ?? null;
        });

      // What each running turn was given to work with, so a narrower policy stops it. Reading a grant
      // and reviewing them take turns, so no change to the policy lands between the two unseen.
      const authority = yield* Semaphore.make(1);
      const granted = new Map<ThreadId, { readonly agentId: AgentId; readonly access: ToolAccess | null }>();
      const currentAccess = (agentId: AgentId) => accessNow(repo, hobTools, agentId);
      const grant = (threadId: ThreadId, agent: Agent) =>
        Semaphore.withPermit(
          authority,
          currentAccess(agent.id).pipe(
            Effect.tap((access) => Effect.sync(() => granted.set(threadId, { agentId: agent.id, access }))),
          ),
        );

      // The turn runs with the configuration it started with; edits made meanwhile apply to the next turn.
      // Its tools are the exception: a narrower policy stops it (reviewAuthority).
      const runTurn = (
        agent: Agent,
        config: AgentConfiguration,
        thread: Thread,
        brain: Brain,
        prompt: string,
        briefing: string | null,
        reply: Reply,
        changed: boolean,
        carry: Carry,
      ) =>
        Effect.gen(function* () {
          const name = agent.name;
          const adapter = adapters(brain.runtime);
          if (adapter === undefined) {
            yield* transition(
              reply,
              (m) => MessageTransitions.cutOff(m, `Hobbots cannot run ${RUNTIME_NAMES[brain.runtime]} on this hub`),
              saveMessage,
            );
            return;
          }
          // Saves the streamed text about once a second without journaling it, so a crash keeps
          // all but the last moment of it (ADR 013). Ending the reply saves it in full.
          let checkpointed = "";
          const checkpoint = Semaphore.withPermit(
            reply.lock,
            Effect.gen(function* () {
              const current = yield* Ref.get(reply.current);
              if (current.content === checkpointed) return;
              yield* repo.checkpointMessage(current);
              checkpointed = current.content;
            }),
          );
          yield* checkpoint.pipe(Effect.delay("1 second"), Effect.forever, Effect.forkScoped);
          const update = (f: (message: Message) => Message | unknown) => transition(reply, f, saveMessage);
          // The session the turn ran in, for the Attempt it may start on a Task.
          let turnSession: string | null = null;

          // Saves a step's change with the reply. A tool call that starts is stamped with when.
          const saveStep = (event: RuntimeEvent) =>
            Effect.gen(function* () {
              const now = yield* nowIso;
              return yield* update((m) => {
                const steps = nextSteps(m.steps, reply.stepsFrom, event, now);
                return steps === null ? undefined : MessageTransitions.setSteps(m, steps);
              });
            });
          // A tool call the policy allowed is saved before it runs, so a crash while it runs leaves it
          // uncertain rather than unknown (EX-004). A reply that has ended takes no new step: refused.
          const recordToolStart = (event: ToolStartedEvent) =>
            saveStep(redactEvent(event, redactor)).pipe(Effect.map(Option.isSome));

          // Secrets are redacted before a tool call's step is saved, journaled or announced, so a client
          // that reads the reply later never receives them either.
          const handle = (raw: RuntimeEvent) => {
            const event = redactEvent(raw, redactor);
            switch (event._tag) {
              // The session has now seen the thread through this reply.
              case "SessionStarted":
                return Effect.gen(function* () {
                  turnSession = event.sessionId;
                  // The runtime accepted the turn: the work it carries is now being processed.
                  yield* carry.accepted(event.sessionId);
                  const seenThrough = (yield* Ref.get(reply.current)).id;
                  const updatedAt = yield* nowIso;
                  const session = { runtime: brain.runtime, sessionId: event.sessionId, seenThrough };
                  yield* changeThread(thread.id, (latest) => {
                    const known = latest.sessions.find((s) => s.runtime === brain.runtime);
                    if (known?.sessionId === session.sessionId && known.seenThrough === seenThrough) return null;
                    const sessions =
                      known === undefined
                        ? [...latest.sessions, session]
                        : latest.sessions.map((s) => (s.runtime === brain.runtime ? session : s));
                    return new Thread({ ...latest, sessions, updatedAt });
                  });
                  if (event.billing && !event.billing.startsWith("subscription") && event.billing !== "fake") {
                    yield* Effect.logWarning(
                      `${RUNTIME_NAMES[brain.runtime]} is billing via ${event.billing}, not the subscription`,
                    );
                  }
                });
              case "TextDelta":
                return transition(
                  reply,
                  (m) => MessageTransitions.appendDelta(m, event.text),
                  (m) =>
                    bus.publishTransient({
                      _tag: "MessageDelta",
                      threadId: m.threadId,
                      messageId: m.id,
                      offset: m.content.length - event.text.length,
                      delta: event.text,
                    }),
                );
              case "Completed":
                return update((m) => MessageTransitions.complete(m, reply.prefix + event.text));
              // What the call printed is cut to its start and end before the step is saved; a long
              // output is kept whole in the step's log.
              case "ToolFinished":
                return Effect.gen(function* () {
                  const current = yield* Ref.get(reply.current);
                  const stepId = replyStepId(current.steps, reply.stepsFrom, event.id);
                  const output =
                    event.output === undefined
                      ? undefined
                      : yield* keepToolOutput(
                          event.output,
                          { threadId: thread.id, messageId: current.id, stepId },
                          toolLogs,
                        );
                  yield* update((m) => {
                    const steps = nextSteps(m.steps, reply.stepsFrom, event, undefined, output);
                    return steps === null ? undefined : MessageTransitions.setSteps(m, steps);
                  });
                });
              // Steps, a tool call's included, are saved with the reply, so they replay on reconnect.
              default:
                return saveStep(event);
            }
          };

          // A request still pending when the turn ends expires: a stopped reply is never approvable late.
          const turnApprovals = Option.isSome(approvals)
            ? yield* Effect.acquireRelease(
                approvals.value.forTurn(
                  { agentId: agent.id, threadId: thread.id, messageId: (yield* Ref.get(reply.current)).id },
                  currentAccess(agent.id),
                ),
                (handle) => handle.close,
              )
            : null;
          // The Task the hob works on in this thread, if any: its tools, and what its steps returned.
          // The turn's Attempt on it ends with the turn.
          const taskTurn = Option.isSome(taskTurns)
            ? yield* Effect.acquireRelease(
                taskTurns.value.forChat({
                  agentId: agent.id,
                  threadId: thread.id,
                  messageId: (yield* Ref.get(reply.current)).id,
                  prompt,
                  runtime: brain.runtime,
                  configVersion: config.version,
                  holding: carry.holding,
                }),
                (turn) =>
                  Ref.get(reply.current).pipe(Effect.flatMap((m) => turn.end(turnOutcome(m.status), turnSession))),
              )
            : null;
          yield* adapter
            .sendPrompt({
              prompt,
              briefing: [briefing, taskTurn?.briefing ?? null].filter((part) => part !== null).join("\n\n") || null,
              sessionId: thread.sessions.find((s) => s.runtime === brain.runtime)?.sessionId ?? null,
              instructions: systemInstructions(name, config),
              instructionsChanged: changed,
              model: brain.model,
              effort: brain.effort,
              tools: yield* grant(thread.id, agent),
              approvals: turnApprovals?.approvals ?? null,
              redaction: redactor,
              recordToolStart,
              hubTools: combineHubTools(
                taskTurn?.hubTools ?? null,
                Option.isSome(charms)
                  ? yield* charms.value.forTurn({ agentId: agent.id, currentAccess: currentAccess(agent.id), redactor })
                  : null,
              ),
            })
            .pipe(
              Stream.runForEach(handle),
              Effect.catchTags({
                // The runtime's error can quote what a tool printed.
                RuntimeError: (error) => update((m) => MessageTransitions.cutOff(m, redactor.text(error.message))),
                RuntimeLimitReached: (error) => update((m) => MessageTransitions.limit(m, error.resetsAt)),
              }),
            );
          // The stream ended without a result: treat it as cut off, not a silent success.
          yield* update((m) => MessageTransitions.cutOff(m, "Runtime ended without a result"));
        }).pipe(
          // Stops the checkpoints as soon as the turn's stream is done.
          Effect.scoped,
          // Runs after the runtime's stream has closed, so "stopped" means the turn really ended.
          Effect.onInterrupt(() => transition(reply, MessageTransitions.interrupt, saveMessage)),
          Effect.ensuring(
            Effect.sync(() => {
              if (replies.get(thread.id) === reply) replies.delete(thread.id);
              granted.delete(thread.id);
            }),
          ),
        );

      // Starts a turn for a prompt that is already stored, or for a continuation's prompt, which
      // Hobbots wrote from the work that arrived (ADR 019): a continuation has no message of yours, so
      // its reply follows the thread's last message. Runs under the hob's lock; the thread is busy
      // from here until the turn's drain releases it, so later prompts queue behind it.
      // `saveReply` stores the new streaming reply; the turn starts only once it is saved.
      const beginTurn = (
        thread: Thread,
        agent: Agent,
        prompt: Message | string,
        saveReply: (reply: Message) => Effect.Effect<Message | null> = saveMessage,
        start: TurnStart = {},
      ) =>
        Effect.gen(function* () {
          const config = yield* repo.findAgentConfig(agent.id, agent.configVersion).pipe(Effect.map(Option.getOrThrow));
          const brain = brainFor(thread, config);
          const now = yield* nowIso;
          const assistantMessage = new Message({
            id: start.replyId ?? MessageId.make(crypto.randomUUID()),
            threadId: thread.id,
            role: "assistant",
            content: "",
            status: "streaming",
            error: null,
            configVersion: config.version,
            runtime: brain.runtime,
            model: brain.model,
            createdAt: now,
          });
          const saved = yield* saveReply(assistantMessage);
          if (saved === null) return null;
          const yours = typeof prompt === "string" ? null : prompt;
          const updated = yield* changeThread(thread.id, (latest) =>
            yours !== null && latest.title === DEFAULT_THREAD_TITLE
              ? new Thread({ ...latest, title: titleFromPrompt(yours.content), updatedAt: now })
              : new Thread({ ...latest, updatedAt: now }),
          ).pipe(Effect.map(Option.getOrElse(() => thread)));
          const content = yours === null ? (prompt as string) : yours.content;
          const turn = yield* launch(agent, config, updated, content, saved, yours?.id ?? null, null, start);
          return { saved, turn };
        });

      // Runs a turn for a reply that is already saved as streaming, on the thread's brain, with what
      // its session missed told first. `promptId` is the turn's own prompt, when it is a message;
      // `continued` the reply Continue resumes, as it was before this turn.
      // Runs under the hob's lock.
      const launch = (
        agent: Agent,
        config: AgentConfiguration,
        thread: Thread,
        prompt: string,
        saved: Message,
        promptId: MessageId | null,
        continued: Message | null = null,
        start: TurnStart = {},
      ) =>
        Effect.gen(function* () {
          const brain = brainFor(thread, config);
          const transcript = (yield* repo.listMessages(thread.id)).filter((m) => m.status !== "queued");
          const before = transcript
            .slice(
              0,
              Math.max(
                0,
                transcript.findIndex((m) => m.id === saved.id),
              ),
            )
            .filter((m) => m.id !== promptId);
          // A reply continued on another brain is told too, with the text and tool steps its first
          // brain left, so the new one does not redo or contradict that work.
          const switched = continued !== null && continued.runtime !== brain.runtime;
          const briefed = yield* brief(thread, brain.runtime, switched ? [...before, continued] : before, switched);
          // Every turn hears of every call the thread left uncertain, whichever brain runs it, since a
          // reply that completes is no proof one was checked: none is repeated unchecked (EX-004).
          // Continue names the continued reply's own.
          const uncertain = uncertainCalls(before.flatMap((m) => (m.role === "assistant" ? m.steps : [])));
          const briefing =
            [briefed, uncertain, start.context ?? null].filter((part) => part !== null).join("\n\n") || null;
          const changed = yield* instructionsChanged(
            thread,
            brain.runtime,
            agent,
            systemInstructions(agent.name, config),
          );
          busy.add(thread.id);
          // Registered before the turn starts, so a stop sent right away still reaches it.
          const reply: Reply = {
            current: yield* Ref.make(saved),
            lock: yield* Semaphore.make(1),
            stepsFrom: saved.steps.length,
            prefix: saved.content,
            // Only work that needs the hob is held back when you stop the turn; progress waits anyway.
            carries: start.carry != null && !start.carry.routineOnly,
          };
          replies.set(thread.id, reply);
          // The drain is forked outside the turn: it waits for the hob's lock, which a retirement
          // may hold while it waits for this very turn to stop.
          const turn = yield* FiberMap.run(
            turns,
            thread.id,
            runTurn(
              agent,
              config,
              thread,
              brain,
              prompt,
              briefing,
              reply,
              changed,
              start.carry ?? NOTHING_CARRIED,
            ).pipe(Effect.ensuring(start.drain === false ? Effect.void : Effect.forkIn(drain(thread.id), scope))),
          );
          yield* announceTurn(thread.id, agent.id, turn);
          return { turn, reply };
        });

      // Tells clients when a turn joins the running turns and when it has left them, so a read of
      // `activeThreads` made on either event already agrees with it. The map drops a turn in the
      // observer it added first, so it is gone before this await returns, after the runtime exited.
      const announceTurn = (threadId: ThreadId, agentId: AgentId, turn: Fiber.Fiber<unknown, unknown>) =>
        Effect.gen(function* () {
          // A turn that already ended never joined the map for long; its end is announced below.
          if (yield* FiberMap.has(turns, threadId)) {
            yield* bus.publishTransient({ _tag: "TurnStarted", threadId, agentId });
          }
          yield* Fiber.await(turn).pipe(
            Effect.andThen(bus.publishTransient({ _tag: "TurnEnded", threadId, agentId })),
            Effect.forkIn(scope),
          );
        });

      // The thread's next queued message: the one chosen with Send now, else the one that has waited longest.
      const nextQueued = (threadId: ThreadId) =>
        Effect.gen(function* () {
          const queued = (yield* repo.listMessages(threadId)).filter((m) => m.status === "queued");
          const next = queued.find((m) => m.id === chosen.get(threadId)) ?? queued[0];
          chosen.delete(threadId);
          if (next === undefined) return null;
          const started = QueuedMessageTransitions.start(next);
          return started instanceof Message ? started : null;
        });

      // The thread and its hob, when the hob takes work and the thread takes new turns.
      const workable = (threadId: ThreadId) =>
        Effect.gen(function* () {
          const thread = yield* repo.findThread(threadId);
          if (Option.isNone(thread) || thread.value.archivedAt !== null) return null;
          const agent = yield* repo.findAgent(thread.value.agentId);
          if (Option.isNone(agent) || agent.value.status !== "active") return null;
          return { thread: thread.value, agent: agent.value };
        });

      // Starts the thread's next queued message, if its hob takes work. Runs under the hob's lock
      // while the thread is not busy. The message starts together with its reply, so a crash cannot
      // leave it started but unanswered.
      const startQueued = (threadId: ThreadId, start: TurnStart = {}) =>
        Effect.gen(function* () {
          const found = yield* repo.findThread(threadId);
          if (Option.isNone(found)) return null;
          const agent = yield* repo.findAgent(found.value.agentId);
          if (Option.isNone(agent) || agent.value.status !== "active") return null;
          const started = yield* nextQueued(threadId);
          if (started === null) return null;
          return yield* beginTurn(found.value, agent.value, started, (reply) => saveStarted(started, reply), start);
        });

      // Starts what waits in the thread (ADR 019), if its hob takes work. Runs under the hob's lock
      // while the thread is not busy. With a backpack, the thread stays busy while the dispatcher
      // puts the work waiting there into its next turn; your queued message still starts first.
      const startNext = (threadId: ThreadId): Effect.Effect<void> =>
        Effect.gen(function* () {
          // A message of yours waiting there takes the work you stopped along with it.
          if (holdBack.has(threadId) && Option.isSome(yield* repo.nextQueuedMessage(threadId))) {
            holdBack.delete(threadId);
          }
          if (Option.isNone(continuations) || holdBack.has(threadId)) {
            yield* startQueued(threadId);
            return;
          }
          const found = yield* workable(threadId);
          if (found === null) {
            yield* startQueued(threadId);
            return;
          }
          busy.add(threadId);
          // The dispatch reads the backpack after this, so it sees whatever a wake until now announced.
          rewake.delete(threadId);
          yield* Effect.forkIn(carryWork(continuations.value, threadId, found.agent.id), scope);
        });

      // Delivers the work waiting in the thread, then frees the thread and starts what waits next.
      // When no turn ran for it and nothing woke the thread meanwhile, only a queued message can be
      // waiting, so the wake ends there.
      const carryWork = (service: Continuations["Service"], threadId: ThreadId, agentId: AgentId) =>
        Effect.gen(function* () {
          const ran = yield* service
            .deliver(threadId, agentId, {
              // Routine progress alone starts no turn: it waits to ride along a message of yours.
              plan: (routineOnly) =>
                admission.withHob(
                  agentId,
                  Effect.gen(function* () {
                    const found = yield* workable(threadId);
                    if (found === null || holdBack.has(threadId)) return null;
                    if (routineOnly && Option.isNone(yield* repo.nextQueuedMessage(threadId))) return null;
                    return MessageId.make(crypto.randomUUID());
                  }),
                ),
              run: (replyId, work) => carryingTurn(threadId, agentId, replyId, work),
            })
            .pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("Could not deliver a hob's backpack work", cause).pipe(Effect.as(false)),
              ),
            );
          yield* admission.withHob(
            agentId,
            Effect.suspend(() => {
              busy.delete(threadId);
              const woken = rewake.delete(threadId);
              return ran || woken ? startNext(threadId) : Effect.asVoid(startQueued(threadId));
            }),
          );
        });

      // One turn that carries the work: your queued message with the work riding along, else a
      // continuation whose prompt is the work. Returns once the turn has ended, and how.
      const carryingTurn = (
        threadId: ThreadId,
        agentId: AgentId,
        replyId: MessageId,
        work: CarriedWork,
      ): Effect.Effect<CarriedEnd> =>
        Effect.gen(function* () {
          const start = { replyId, carry: work, drain: false } as const;
          const begun = yield* admission.withHob(
            agentId,
            Effect.gen(function* () {
              const found = yield* workable(threadId);
              if (found === null || holdBack.has(threadId)) return null;
              const queued = yield* startQueued(threadId, { ...start, context: work.text("context") });
              if (queued !== null) return queued.turn;
              // The message it was to ride along is gone: routine progress waits for the next one.
              if (work.routineOnly) return null;
              const continued = yield* beginTurn(found.thread, found.agent, work.text("prompt"), saveMessage, start);
              return continued?.turn ?? null;
            }),
          );
          if (begun === null) return { _tag: "EndedEarly", reason: "Its hob or thread no longer takes work." };
          // A dispatch that stops waiting, as when the turn's claim is lost, stops the turn too, so
          // no second turn starts over it.
          yield* Fiber.await(begun.turn).pipe(Effect.onInterrupt(() => FiberMap.remove(turns, threadId)));
          const ended = yield* Ref.get(begun.reply.current);
          if (ended.status === "complete") return { _tag: "Handled" };
          return { _tag: "EndedEarly", reason: ended.error ?? `The turn ended as ${ended.status}.` };
        });

      // After a turn ends, frees its thread and starts what queued behind it.
      const drain = (threadId: ThreadId) =>
        Effect.gen(function* () {
          // The ended turn may still be leaving the map; a new turn must not replace it there.
          const ended = yield* FiberMap.get(turns, threadId);
          if (Option.isSome(ended)) yield* Fiber.await(ended.value);
          const thread = yield* repo.findThread(threadId);
          if (Option.isNone(thread)) return busy.delete(threadId);
          yield* admission.withHob(
            thread.value.agentId,
            Effect.suspend(() => {
              busy.delete(threadId);
              return startNext(threadId);
            }),
          );
        });

      // Starts what waits in each idle thread: after a restart, when a paused hob wakes, or when
      // work arrives for its hob.
      const drainThreads = (threadIds: ReadonlyArray<ThreadId>) =>
        Effect.forEach(threadIds, (threadId) =>
          repo.findThread(threadId).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.void,
                onSome: (thread) =>
                  admission.withHob(
                    thread.agentId,
                    Effect.suspend(() =>
                      busy.has(threadId) ? Effect.sync(() => rewake.add(threadId)) : startNext(threadId),
                    ),
                  ),
              }),
            ),
          ),
        );

      // Reads the thread and its hob again under the hob's lock, so neither changes before `body` ends.
      const withThreadHob = <A, E, R>(
        threadId: ThreadId,
        body: (thread: Thread, agent: Agent) => Effect.Effect<A, E, R>,
      ) =>
        Effect.gen(function* () {
          const { agentId } = yield* findThread(threadId);
          return yield* admission.withHob(
            agentId,
            Effect.gen(function* () {
              const thread = yield* findThread(threadId);
              const agent = yield* repo.findAgent(thread.agentId).pipe(Effect.map(Option.getOrThrow));
              return yield* body(thread, agent);
            }),
          );
        });

      // Whether your next message carries work: work you stopped in the thread, or routine
      // progress, which reaches the hob only as a digest along its next turn (IN-005).
      const workRidesAlong = (threadId: ThreadId, agentId: AgentId) =>
        Effect.gen(function* () {
          if (Option.isNone(continuations)) return false;
          const service = continuations.value;
          if (holdBack.has(threadId) && (yield* service.waiting(agentId)).includes(threadId)) return true;
          return yield* service.progressWaits(threadId, agentId);
        });

      const sendPrompt = Effect.fn("ChatService.sendPrompt")(function* (threadId: ThreadId, content: string) {
        // The status check and the turn's registration happen under the hob's lock, so a turn is
        // either admitted before a retirement (which then sees and stops it) or refused after it.
        return yield* withThreadHob(threadId, (thread, agent) =>
          Effect.gen(function* () {
            // A retired hob takes nothing; a paused one keeps messages queued until it wakes.
            if (agent.status === "retired") yield* requireActive(agent);
            yield* requireLive(thread);
            // A message waits while its hob is paused, while a reply runs, and behind any message
            // already waiting, so the thread's messages start in the order they were sent (CH-008).
            const waits =
              agent.status === "paused" || busy.has(threadId) || Option.isSome(yield* repo.nextQueuedMessage(threadId));
            // Work you stopped here, and routine progress, ride along: the message starts through the
            // dispatcher, under their claims.
            const carries = !waits && (yield* workRidesAlong(threadId, agent.id));
            const userMessage = new Message({
              id: MessageId.make(crypto.randomUUID()),
              threadId,
              role: "user",
              content,
              status: waits || carries ? "queued" : "complete",
              error: null,
              configVersion: null,
              createdAt: yield* nowIso,
            });
            const saved = yield* saveMessage(userMessage);
            // A message that waits behind a busy thread has the thread look at its work again once it
            // is free, so a dispatch that already found nothing does not start it without its progress.
            if (busy.has(threadId)) rewake.add(threadId);
            // Work you stopped in this thread may start again once this message is answered.
            holdBack.delete(threadId);
            if (carries) yield* startNext(threadId);
            if (waits || carries) return { userMessage: saved, assistantMessage: null };
            const begun = yield* beginTurn(thread, agent, saved);
            return { userMessage: saved, assistantMessage: begun?.saved ?? null };
          }),
        );
      });

      const removeQueued = Effect.fn("ChatService.removeQueued")(function* (threadId: ThreadId, messageId: MessageId) {
        const { agentId } = yield* findThread(threadId);
        yield* admission.withHob(
          agentId,
          Effect.gen(function* () {
            if (!(yield* saveRemoved(threadId, messageId))) return yield* new MessageNotQueued({ messageId });
            if (chosen.get(threadId) === messageId) chosen.delete(threadId);
          }),
        );
      });

      // The choice is held in memory: after a restart the queue simply keeps its order.
      const sendNow = Effect.fn("ChatService.sendNow")(function* (threadId: ThreadId, messageId: MessageId) {
        const { agentId } = yield* findThread(threadId);
        yield* admission.withHob(
          agentId,
          Effect.gen(function* () {
            const messages = yield* repo.listMessages(threadId);
            if (!messages.some((m) => m.id === messageId && m.status === "queued")) {
              return yield* new MessageNotQueued({ messageId });
            }
            chosen.set(threadId, messageId);
            // The chosen message starts in the drain once the stopped turn has ended.
            if (busy.has(threadId)) yield* stop(threadId);
            else yield* startNext(threadId);
          }),
        );
      });

      const stop = Effect.fn("ChatService.stop")(function* (threadId: ThreadId) {
        yield* findThread(threadId);
        const reply = replies.get(threadId);
        if (!reply) return;
        // Only the first request moves the reply to stopping and interrupts the turn.
        const requested = yield* transition(
          reply,
          (m) => (m.status === "streaming" ? MessageTransitions.requestStop(m) : undefined),
          saveMessage,
        );
        // Work the turn carried waits for you instead of starting again on its own.
        if (Option.isSome(requested) && reply.carries) holdBack.add(threadId);
        // The turn records the confirmed outcome itself once the runtime has stopped.
        if (Option.isSome(requested)) yield* Effect.forkIn(FiberMap.remove(turns, threadId), scope);
      });

      // The reply streams again with the configuration the hob has now, like any new turn.
      const continueReply = Effect.fn("ChatService.continueReply")(function* (
        threadId: ThreadId,
        messageId: MessageId,
      ) {
        return yield* withThreadHob(threadId, (thread, agent) =>
          Effect.gen(function* () {
            yield* requireActive(agent);
            yield* requireLive(thread);
            const transcript = (yield* repo.listMessages(threadId)).filter((m) => m.status !== "queued");
            const message = transcript.at(-1);
            if (busy.has(threadId) || message?.id !== messageId || !isResumable(message.status)) {
              return yield* new ReplyNotResumable({ messageId });
            }
            const resumed = MessageTransitions.resume(message);
            if (!(resumed instanceof Message)) return yield* new ReplyNotResumable({ messageId });
            const config = yield* repo
              .findAgentConfig(agent.id, agent.configVersion)
              .pipe(Effect.map(Option.getOrThrow));
            // The reply is now the brain's that continues it.
            const brain = brainFor(thread, config);
            const saved = yield* saveMessage(
              new Message({ ...resumed, configVersion: config.version, runtime: brain.runtime, model: brain.model }),
            );
            yield* launch(agent, config, thread, continuePrompt(message), saved, null, message);
            return saved;
          }),
        );
      });

      const activeThreads = Effect.sync(() => Array.from(turns, ([threadId]) => threadId));
      const streamingReplies = Effect.suspend(() =>
        Effect.forEach(Array.from(replies.values()), (reply) => Ref.get(reply.current)),
      ).pipe(Effect.map((messages) => messages.filter((message) => isInProgress(message.status))));
      const interruptAgent = Effect.fn("ChatService.interruptAgent")(function* (agentId: AgentId) {
        for (const threadId of yield* activeThreads) {
          const thread = yield* repo.findThread(threadId);
          if (Option.isSome(thread) && thread.value.agentId === agentId) yield* FiberMap.remove(turns, threadId);
        }
        if (Option.isSome(taskTurns)) yield* taskTurns.value.interruptAgent(agentId);
      });

      const reviewAuthority = Effect.fn("ChatService.reviewAuthority")(function* (agentId?: AgentId) {
        // The grants are listed once the permit is held, so a grant that was being read is listed too.
        const narrowed = yield* Semaphore.withPermit(
          authority,
          Effect.suspend(() =>
            Effect.filter(
              Array.from(granted).filter(([, turn]) => agentId === undefined || turn.agentId === agentId),
              ([, turn]) => Effect.map(currentAccess(turn.agentId), (access) => narrows(turn.access, access)),
            ),
          ),
        );
        // Outside the permit: a turn that is stopping may still be reading its grant.
        yield* Effect.forEach(narrowed, ([threadId]) => FiberMap.remove(turns, threadId), { discard: true });
        if (Option.isSome(taskTurns)) yield* taskTurns.value.reviewAuthority(agentId);
      });

      const checkBrainSwitch = Effect.fn("ChatService.checkBrainSwitch")(function* (threadId: ThreadId) {
        const thread = yield* findThread(threadId);
        const agent = yield* repo.findAgent(thread.agentId).pipe(Effect.map(Option.getOrThrow));
        if (agent.status === "retired") yield* requireActive(agent);
        yield* requireLive(thread);
      });

      const followHob = Effect.fn("ChatService.followHob")(function* (threadId: ThreadId) {
        const thread = yield* findThread(threadId);
        const updatedAt = yield* nowIso;
        const changed = yield* changeThread(threadId, (latest) =>
          latest.brain === null ? null : new Thread({ ...latest, brain: null, updatedAt }),
        );
        return Option.getOrElse(changed, () => thread);
      });

      const setBrain = Effect.fn("ChatService.setBrain")(function* (threadId: ThreadId, brain: Brain | null) {
        return yield* withThreadHob(threadId, (thread, agent) =>
          Effect.gen(function* () {
            if (agent.status === "retired") yield* requireActive(agent);
            yield* requireLive(thread);
            if (brain !== null) {
              const invalid = yield* checkRuntimeBrain(adapters, brain);
              if (invalid !== undefined) return yield* invalid;
            }
            const hob = { runtime: agent.runtime, model: agent.model, effort: agent.effort };
            const own = brain !== null && sameBrain(brain, hob) ? null : brain;
            const updatedAt = yield* nowIso;
            const changed = yield* changeThread(threadId, (latest) =>
              sameOwnBrain(latest.brain, own) ? null : new Thread({ ...latest, brain: own, updatedAt }),
            );
            return Option.getOrElse(changed, () => thread);
          }),
        );
      });

      // Why the thread cannot be archived now, if anything stops it. Runs under the hob's lock, so no
      // turn starts and no message is sent while the thread is being archived.
      const archiveRefusal = (thread: Thread, agent: Agent) =>
        Effect.gen(function* () {
          if (agent.status === "retired") return "hob-retired" as const;
          if (Option.isSome(approvals)) {
            const requests = yield* approvals.value.listForThread(thread.id);
            if (requests.some((request) => request.state === "pending")) return "approval-pending" as const;
          }
          // A turn whose reply has ended no longer stops it, even before its thread is freed.
          const messages = yield* repo.listMessages(thread.id);
          return messages.some((m) => m.status === "queued" || isInProgress(m.status))
            ? ("reply-running" as const)
            : null;
        });
      const refuse = (threadId: ThreadId, reason: ThreadArchiveRefusal) =>
        Effect.fail(new ThreadArchiveRefused({ threadId, reason }));

      // Neither changes `updatedAt`, so a restored thread goes back to its place in the list.
      const setArchivedAt = (thread: Thread, archivedAt: string | null) =>
        changeThread(thread.id, (latest) =>
          (latest.archivedAt === null) === (archivedAt === null) ? null : new Thread({ ...latest, archivedAt }),
        ).pipe(Effect.map(Option.getOrElse(() => thread)));

      const archive = Effect.fn("ChatService.archive")(function* (threadId: ThreadId) {
        return yield* withThreadHob(threadId, (thread, agent) =>
          Effect.gen(function* () {
            if (thread.archivedAt !== null) return thread;
            const reason = yield* archiveRefusal(thread, agent);
            if (reason !== null) return yield* refuse(threadId, reason);
            return yield* setArchivedAt(thread, yield* nowIso);
          }),
        );
      });

      const restore = Effect.fn("ChatService.restore")(function* (threadId: ThreadId) {
        return yield* withThreadHob(
          threadId,
          (thread, agent) =>
            Effect.gen(function* () {
              if (thread.archivedAt === null) return thread;
              if (agent.status === "retired") return yield* refuse(threadId, "hob-retired");
              return yield* setArchivedAt(thread, null);
            }),
          // Work that arrived while it was archived starts once it is back.
        ).pipe(Effect.tap(() => drainThreads([threadId])));
      });

      // The threads with your queued messages or backpack work waiting: of one hob, or of every hob.
      const threadsWaiting = (agentId?: AgentId) =>
        Effect.gen(function* () {
          const queued = yield* repo.threadsWithQueuedMessages;
          const work = Option.isSome(continuations) ? yield* continuations.value.waiting(agentId) : [];
          return [...new Set([...queued, ...work])];
        });

      const drainAgent = Effect.fn("ChatService.drainAgent")(function* (agentId: AgentId) {
        // A hob that wakes takes up the work you stopped in its threads too.
        const threads = yield* threadsWaiting(agentId);
        const own = yield* Effect.filter(threads, (threadId) =>
          repo.findThread(threadId).pipe(Effect.map((t) => Option.isSome(t) && t.value.agentId === agentId)),
        );
        for (const threadId of own) holdBack.delete(threadId);
        yield* drainThreads(own);
        if (Option.isSome(taskTurns)) yield* taskTurns.value.drainAgent(agentId);
      });

      const wake = (threadId: ThreadId) => drainThreads([threadId]);

      // Messages queued and work left waiting before a restart start again, through the same path
      // as any other.
      yield* drainThreads(yield* threadsWaiting());

      return ChatService.of({
        createThread,
        sendPrompt,
        removeQueued,
        sendNow,
        stop,
        continueReply,
        interruptAgent,
        reviewAuthority,
        setBrain,
        checkBrainSwitch,
        followHob,
        archive,
        restore,
        drainAgent,
        wake,
        activeThreads,
        streamingReplies,
      });
    }),
  );
}
