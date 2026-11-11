import {
  AgentNotFound,
  HobUnavailable,
  type InvalidHob,
  MessageNotQueued,
  ReplyNotResumable,
  ThreadArchived,
  ThreadArchiveRefused,
  ThreadNotFound,
} from "@hobbots/api";
import {
  type Agent,
  type AgentConfiguration,
  type AgentId,
  type BackpackTurnEnd,
  type Brain,
  type Committed,
  DEFAULT_THREAD_TITLE,
  hobStanding,
  type IllegalThreadTransition,
  isInProgress,
  isResumable,
  Message,
  MessageId,
  type MessageStatus,
  MessageTransitions,
  openThreadTask,
  QueuedMessageTransitions,
  replyActivity,
  type SkillMention,
  type SkillTrial,
  sameBrain,
  systemInstructions,
  Thread,
  ThreadId,
  ThreadLifecycle,
  type ThreadLifecycleEvent,
  type ThreadRunStatus,
  takesNewWork,
  titleFromPrompt,
  waitedSteps,
} from "@hobbots/domain";
import { Context, DateTime, Deferred, Effect, Fiber, FiberMap, HashMap, Layer, Option, Ref, Semaphore } from "effect";
import { HobAdmission } from "./admission.ts";
import { ApprovalService } from "./approvals.ts";
import { type CarriedEnd, type CarriedWork, Continuations } from "./continuations.ts";
import { checkRuntimeBrain } from "./hobs.ts";
import { EventPublisher } from "./ports.ts";
import { HobbotsRepository } from "./repository.ts";
import { runtimeAdapters } from "./runtime.ts";
import { makeRedactor, SecretRedaction } from "./secrets.ts";
import { mentionedSkill, namedSkills } from "./skill-turn.ts";
import { stoppedCommands, uncertainCalls } from "./steps.ts";
import { TaskTurns } from "./task-turns.ts";
import { TaskRepository } from "./tasks.ts";
import {
  idleRun,
  isAtRest,
  isBusy,
  type Reply,
  runStatus,
  type ThreadRun,
  type ThreadRunEvent,
  ThreadRunMachine,
} from "./thread-run.ts";
import { HobTools } from "./tools.ts";
import { makeTurnGrants } from "./turn-grants.ts";
import { makeTurnInputs } from "./turn-inputs.ts";
import { type Carry, makeTurnRunner } from "./turn-runner.ts";
import { workHeld } from "./work-hold.ts";

/** What a turn carries when it carries no backpack items. */
const NOTHING_CARRIED: Carry = {
  holding: [],
  accepted: () => Effect.void,
  late: Effect.succeed(false),
  routineOnly: true,
};

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

/** How a turn that carried work ended early, as a code: a reply still running was interrupted. */
const turnEnd = (status: MessageStatus): BackpackTurnEnd =>
  status === "failed" || status === "stopped" || status === "limited" ? status : "interrupted";

/** The brain a thread's turn thinks with: the thread's own, else the hob's configuration's. */
const brainFor = (thread: Thread, config: AgentConfiguration): Brain =>
  thread.brain ?? { runtime: config.runtime, model: config.model, effort: config.effort };

const sameOwnBrain = (a: Brain | null, b: Brain | null) => (a === null || b === null ? a === b : sameBrain(a, b));

export class ChatService extends Context.Service<
  ChatService,
  {
    /**
     * Starts a new thread for the hob. With `skillTrial`, the thread tries that draft (ADR 029, Try in a
     * chat): every turn of it loads the draft and no other skill, under `title`.
     */
    readonly createThread: (
      agentId: AgentId,
      options?: { readonly title?: string; readonly skillTrial?: SkillTrial },
    ) => Effect.Effect<Thread, AgentNotFound | HobUnavailable>;
    /** Starts a turn, or queues the message while the thread's reply runs (assistantMessage is then null). */
    readonly sendPrompt: (
      threadId: ThreadId,
      content: string,
      /** The skill you picked for the message with `/` (ADR 029, Explicit use), if any. */
      askedSkill?: SkillMention | null,
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
     * Stop waiting (#1056): once the hob has answered and its reply only waits on commands it started,
     * ends the reply now. The reply shows as stopping, then completes with its text, and each command
     * it waited on is stopped. With no reply waiting, it changes nothing.
     */
    readonly stopWaiting: (threadId: ThreadId) => Effect.Effect<void, ThreadNotFound>;
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
    /** Renames the thread. Refused while it is archived. */
    readonly rename: (threadId: ThreadId, title: string) => Effect.Effect<Thread, ThreadNotFound | ThreadArchived>;
    /** Pins the thread to the top of its hob's chats, or unpins it. Refused while it is archived. */
    readonly setPinned: (threadId: ThreadId, pinned: boolean) => Effect.Effect<Thread, ThreadNotFound | ThreadArchived>;
    /**
     * Records that you read the thread through `messageId`, as you saw it at `revision` (ADR 027), so
     * its unread dot clears on every device. The marker only moves forward: a message you had read
     * past, or one from another thread, returns the thread as it is. An archived thread takes it too.
     */
    readonly markRead: (
      threadId: ThreadId,
      messageId: MessageId,
      revision: number,
    ) => Effect.Effect<Thread, ThreadNotFound>;
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
     * Wakes the thread even when you stopped its work there, as when you retry that work's blocker:
     * your choice starts it again without a message of yours.
     */
    readonly resume: (threadId: ThreadId) => Effect.Effect<void>;
    /**
     * Threads with a turn in progress in this process, until its runtime has exited. Each change is
     * announced as the transient `TurnStarted` or `TurnEnded`, published once it has happened.
     */
    readonly activeThreads: Effect.Effect<ReadonlyArray<ThreadId>>;
    /**
     * Every thread whose run is not idle, as `ThreadRunChanged` publishes it, and the revision of the
     * last transition of any run: a thread left out is idle as of that revision (ADR 037).
     */
    readonly threadRuns: Effect.Effect<{ readonly revision: number; readonly runs: ReadonlyArray<ThreadRunStatus> }>;
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
      // Without Task work, turns offer no Task tools and hobs run no steps.
      const taskTurns = yield* Effect.serviceOption(TaskTurns);
      const taskRecords = yield* Effect.serviceOption(TaskRepository);
      const { memoryBriefFor, rosterFor, acceptedIn, skillsFor, instructionsChanged, brief } = yield* makeTurnInputs(
        repo,
        hobTools,
        redactor,
      );
      // Without a backpack, a thread starts only your queued messages.
      const continuations = yield* Effect.serviceOption(Continuations);
      // After a restore nothing that waited starts on its own until you resume work (ADR 026).
      const held = yield* workHeld;
      const turns = yield* FiberMap.make<ThreadId>();
      const scope = yield* Effect.scope;
      // Every thread's run (ADR 037), changed only through `ThreadRunMachine`. In memory, as turns
      // are; the queue itself is the stored queued messages. A thread with no entry is idle.
      // `revision` counts every transition, so clients can order what each publishes.
      interface Runs {
        readonly all: HashMap.HashMap<ThreadId, ThreadRun>;
        readonly revision: number;
      }
      const runs = yield* Ref.make<Runs>({ all: HashMap.empty(), revision: 0 });
      interface StepResult {
        readonly before: ThreadRun;
        readonly taken: boolean;
      }
      const runOf = (threadId: ThreadId) =>
        Ref.get(runs).pipe(Effect.map(({ all }) => Option.getOrElse(HashMap.get(all, threadId), () => idleRun)));
      // Applies an event to the thread's run: `taken` says whether its rules allowed it, and `before`
      // is the run it found. A run back at rest is dropped, so the map holds only what is remembered.
      // Every transition taken is published once as `ThreadRunChanged`, after the change.
      const step = (threadId: ThreadId, event: ThreadRunEvent) =>
        Ref.modify(runs, (current): readonly [StepResult & { readonly published: ThreadRunStatus | null }, Runs] => {
          const before = Option.getOrElse(HashMap.get(current.all, threadId), () => idleRun);
          const after = ThreadRunMachine.transition(before, event);
          if (typeof after === "string") return [{ before, taken: false, published: null }, current];
          const revision = current.revision + 1;
          const all = isAtRest(after)
            ? HashMap.remove(current.all, threadId)
            : HashMap.set(current.all, threadId, after);
          return [
            { before, taken: true, published: runStatus(threadId, after, revision) },
            { all, revision },
          ];
        }).pipe(
          Effect.tap(({ published }) =>
            published === null ? Effect.void : bus.publishTransient({ _tag: "ThreadRunChanged", run: published }),
          ),
          Effect.map(({ before, taken }): StepResult => ({ before, taken })),
        );
      // An event the run loop only sends when the run allows it: a refusal is a bug in the loop.
      const must = (threadId: ThreadId, event: ThreadRunEvent) =>
        step(threadId, event).pipe(
          Effect.flatMap((result) =>
            result.taken
              ? Effect.succeed(result)
              : Effect.die(new Error(`ThreadRun: ${event._tag} is not allowed while the run is ${result.before.run}`)),
          ),
        );

      const findThread = (threadId: ThreadId) =>
        repo.findThread(threadId).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.fail(new ThreadNotFound({ threadId })),
              onSome: Effect.succeed,
            }),
          ),
        );

      // Only an active hob takes new work; a paused or retired hob's threads stay readable, and so do
      // those of a hob finishing its open Tasks before it retires.
      const requireActive = (agent: Agent) =>
        takesNewWork(agent)
          ? Effect.void
          : Effect.fail(new HobUnavailable({ agentId: agent.id, status: hobStanding(agent) }));

      // A hob that is awake: it may go on with work it already has, even while it finishes its open
      // Tasks before it retires (#408); `requireActive` also turns away new work.
      const requireAwake = (agent: Agent) =>
        agent.status === "active"
          ? Effect.void
          : Effect.fail(new HobUnavailable({ agentId: agent.id, status: hobStanding(agent) }));

      // A hob finishing its open Tasks before it retires takes messages only in a thread where one
      // of them is open, since they go on with it; anywhere else a message would be new work (#408).
      const requireOpenTaskWhileRetiring = (agent: Agent, threadId: ThreadId) =>
        Effect.gen(function* () {
          if (agent.retiring === null || agent.status === "retired") return;
          const trees = Option.isSome(taskRecords) ? yield* taskRecords.value.readThreadTrees(threadId) : [];
          if (openThreadTask(trees, agent.id) === undefined) {
            return yield* new HobUnavailable({ agentId: agent.id, status: "retiring" });
          }
        });

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
      const createThread = Effect.fn("ChatService.createThread")(function* (
        agentId: AgentId,
        options: { readonly title?: string; readonly skillTrial?: SkillTrial } = {},
      ) {
        return yield* admission.withHob(
          agentId,
          Effect.gen(function* () {
            const agent = yield* repo.findAgent(agentId);
            if (Option.isNone(agent)) return yield* new AgentNotFound({ agentId });
            yield* requireActive(agent.value);
            const now = yield* nowIso;
            // The hob's first open thread is its chat (ADR 037); a skill trial is always a camp.
            const hasChat = (yield* repo.listThreads(agentId)).some(ThreadLifecycle.isOpenChat);
            const thread = new Thread({
              id: ThreadId.make(crypto.randomUUID()),
              agentId,
              title: options.title ?? DEFAULT_THREAD_TITLE,
              kind: hasChat || options.skillTrial !== undefined ? "camp" : "chat",
              skillTrial: options.skillTrial ?? null,
              createdAt: now,
              updatedAt: now,
            });
            return yield* saveThread(thread);
          }),
        );
      });

      // The reply in memory becomes `next`, and the thread's run learns what the reply is doing now.
      // A reply that no longer runs there changes nothing in the run.
      const setReply = (reply: Reply, next: Message) =>
        Ref.set(reply.current, next).pipe(
          Effect.andThen(step(next.threadId, { _tag: "ReplyChanged", reply, activity: replyActivity(next) })),
          Effect.asVoid,
        );

      // Applies a domain transition to a running reply, `apply` taking the result in. The lock keeps
      // the turn and a stop request from saving out of order. Finished replies reject changes, so late
      // runtime events and repeated stops are ignored.
      const changeReply = <A>(
        reply: Reply,
        f: (message: Message) => Message | unknown,
        apply: (next: Message) => Effect.Effect<A>,
      ) =>
        Semaphore.withPermit(
          reply.lock,
          Effect.gen(function* () {
            const next = f(yield* Ref.get(reply.current));
            return next instanceof Message ? Option.some(yield* apply(next)) : Option.none<A>();
          }),
        );

      // The reply in memory takes the result, then `after` runs with it.
      const transition = <A>(
        reply: Reply,
        f: (message: Message) => Message | unknown,
        after: (next: Message) => Effect.Effect<A>,
      ) => changeReply(reply, f, (next) => Effect.andThen(setReply(reply, next), after(next)));

      // The reply in memory takes the result only once `save` has committed it, and the save is not cut
      // short: a stop that comes while it runs waits for it. So a stop's own save, which starts from the
      // reply in memory, never writes what was not committed, nor drops what was.
      const committedTransition = <A>(
        reply: Reply,
        f: (message: Message) => Message | unknown,
        save: (next: Message) => Effect.Effect<A>,
      ) => changeReply(reply, f, (next) => Effect.uninterruptible(Effect.tap(save(next), () => setReply(reply, next))));

      const grants = yield* makeTurnGrants(repo, hobTools);
      const { runTurn } = yield* makeTurnRunner({
        redactor,
        grants,
        inputs: { memoryBriefFor, rosterFor, skillsFor },
        saveMessage,
        announce,
        changeThread,
        transition,
        committedTransition,
        turnEnded: (threadId, reply) => step(threadId, { _tag: "TurnEnded", reply }),
      });

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
            promptId: typeof prompt === "string" ? null : prompt.id,
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
          // The turn right after a reply hears of the commands you stopped while it waited (#1056).
          const lastReply = before.findLast((m) => m.role === "assistant");
          const stopped = lastReply === undefined ? null : stoppedCommands(lastReply.steps);
          const briefing =
            [briefed, uncertain, stopped, start.context ?? null].filter((part) => part !== null).join("\n\n") || null;
          const changed = yield* instructionsChanged(
            thread,
            brain.runtime,
            agent,
            systemInstructions(config.name, config),
          );
          // Registered before the turn starts, so a stop sent right away still reaches it.
          const reply: Reply = {
            current: yield* Ref.make(saved),
            lock: yield* Semaphore.make(1),
            stepsFrom: saved.steps.length,
            prefix: saved.content,
            // Only work that needs the hob is held back when you stop the turn; progress waits anyway.
            carries: start.carry != null && !start.carry.routineOnly,
            endWait: yield* Deferred.make<void>(),
            waitsStopped: yield* Ref.make<number | null>(null),
          };
          yield* must(thread.id, { _tag: "Launch", reply, activity: replyActivity(saved) });
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
              // The message of yours the reply answers, as you wrote it, which Continue keeps (#1005).
              saved.promptId === null ? undefined : transcript.find((m) => m.id === saved.promptId),
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
          const { chosen } = yield* runOf(threadId);
          const next = queued.find((m) => m.id === chosen) ?? queued[0];
          yield* step(threadId, { _tag: "Unchoose", messageId: null });
          if (next === undefined) return null;
          const started = QueuedMessageTransitions.start(next);
          return started instanceof Message ? started : null;
        });

      // The thread and its hob, when the hob takes work and the thread takes new turns.
      const workable = (threadId: ThreadId) =>
        Effect.gen(function* () {
          const thread = yield* repo.findThread(threadId);
          if (Option.isNone(thread) || !ThreadLifecycle.isOpen(thread.value)) return null;
          const agent = yield* repo.findAgent(thread.value.agentId);
          if (Option.isNone(agent) || agent.value.status !== "active") return null;
          return { thread: thread.value, agent: agent.value };
        });

      // Starts the thread's next queued message, if its hob takes work. Runs under the hob's lock
      // while the thread is not busy. The message starts together with its reply, so a crash cannot
      // leave it started but unanswered.
      const startQueued = (threadId: ThreadId, start: TurnStart = {}) =>
        Effect.gen(function* () {
          if (yield* held) return null;
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
          if (yield* held) return;
          // A message of yours waiting there takes the work you stopped along with it.
          if ((yield* runOf(threadId)).held && Option.isSome(yield* repo.nextQueuedMessage(threadId))) {
            yield* step(threadId, { _tag: "Release" });
          }
          if (Option.isNone(continuations) || (yield* runOf(threadId)).held) {
            yield* startQueued(threadId);
            return;
          }
          const found = yield* workable(threadId);
          if (found === null) {
            yield* startQueued(threadId);
            return;
          }
          // The dispatch reads the backpack after this, so it sees whatever a wake until now announced.
          yield* must(threadId, { _tag: "Dispatch" });
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
                    if (found === null || (yield* runOf(threadId)).held) return null;
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
            Effect.gen(function* () {
              const { before } = yield* must(threadId, { _tag: "Delivered" });
              yield* ran || before.wakePending ? startNext(threadId) : Effect.asVoid(startQueued(threadId));
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
              if (found === null || (yield* runOf(threadId)).held) return null;
              const queued = yield* startQueued(threadId, { ...start, context: work.text("context") });
              if (queued !== null) return queued.turn;
              // The message it was to ride along is gone: routine progress waits for the next one.
              if (work.routineOnly) return null;
              // Work that went late while the turn waited to start, as when you cancel its Quest,
              // starts nothing: it resolves as late (#993).
              if (yield* work.late) return null;
              const continued = yield* beginTurn(found.thread, found.agent, work.text("prompt"), saveMessage, start);
              return continued?.turn ?? null;
            }),
          );
          if (begun === null) return { _tag: "EndedEarly", end: "unavailable", diagnostic: null };
          // A dispatch that stops waiting, as when the turn's claim is lost, stops the turn too, so
          // no second turn starts over it.
          yield* Fiber.await(begun.turn).pipe(Effect.onInterrupt(() => FiberMap.remove(turns, threadId)));
          const ended = yield* Ref.get(begun.reply.current);
          if (ended.status === "complete") return { _tag: "Handled" };
          // The reply's error is what the runtime said; how the turn ended is a code the client words.
          return { _tag: "EndedEarly", end: turnEnd(ended.status), diagnostic: ended.error ?? null };
        });

      // After a turn ends, frees its thread and starts what queued behind it.
      const drain = (threadId: ThreadId) =>
        Effect.gen(function* () {
          // The ended turn may still be leaving the map; a new turn must not replace it there.
          const ended = yield* FiberMap.get(turns, threadId);
          if (Option.isSome(ended)) yield* Fiber.await(ended.value);
          const thread = yield* repo.findThread(threadId);
          if (Option.isNone(thread)) {
            yield* step(threadId, { _tag: "Drained" });
            return;
          }
          yield* admission.withHob(
            thread.value.agentId,
            step(threadId, { _tag: "Drained" }).pipe(Effect.andThen(startNext(threadId))),
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
                    runOf(threadId).pipe(
                      Effect.flatMap((run) =>
                        isBusy(run) ? Effect.asVoid(step(threadId, { _tag: "WakeLater" })) : startNext(threadId),
                      ),
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
          if ((yield* runOf(threadId)).held && (yield* service.waiting(agentId)).includes(threadId)) return true;
          return yield* service.progressWaits(threadId, agentId);
        });

      const sendPrompt = Effect.fn("ChatService.sendPrompt")(function* (
        threadId: ThreadId,
        content: string,
        askedSkill: SkillMention | null = null,
      ) {
        // The status check and the turn's registration happen under the hob's lock, so a turn is
        // either admitted before a retirement (which then sees and stops it) or refused after it.
        return yield* withThreadHob(threadId, (thread, agent) =>
          Effect.gen(function* () {
            // A retired hob takes nothing; a paused one keeps messages queued until it wakes.
            if (agent.status === "retired") yield* requireActive(agent);
            yield* requireOpenTaskWhileRetiring(agent, threadId);
            yield* requireLive(thread);
            // A message waits while its hob is paused, while a reply runs, and behind any message
            // already waiting, so the thread's messages start in the order they were sent (CH-008).
            const busy = isBusy(yield* runOf(threadId));
            const waits = agent.status === "paused" || busy || Option.isSome(yield* repo.nextQueuedMessage(threadId));
            // Work you stopped here, and routine progress, ride along: the message starts through the
            // dispatcher, under their claims.
            const carries = !waits && (yield* workRidesAlong(threadId, agent.id));
            const accepted = yield* acceptedIn(thread, agent);
            const named = namedSkills(accepted, thread.skillTrial);
            const userMessage = new Message({
              id: MessageId.make(crypto.randomUUID()),
              threadId,
              role: "user",
              content,
              status: waits || carries ? "queued" : "complete",
              error: null,
              configVersion: null,
              skills: accepted,
              // A skill of a set picked by its name alone is recorded with its set, when that names one.
              askedSkill:
                askedSkill === null
                  ? mentionedSkill(content, named)
                  : (mentionedSkill(`/${askedSkill}`, named) ?? askedSkill),
              createdAt: yield* nowIso,
            });
            const saved = yield* saveMessage(userMessage);
            // A message that waits behind a busy thread has the thread look at its work again once it
            // is free, so a dispatch that already found nothing does not start it without its progress.
            if (isBusy(yield* runOf(threadId))) yield* step(threadId, { _tag: "WakeLater" });
            // Work you stopped in this thread may start again once this message is answered.
            yield* step(threadId, { _tag: "Release" });
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
            yield* step(threadId, { _tag: "Unchoose", messageId });
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
            yield* step(threadId, { _tag: "Choose", messageId });
            // The chosen message starts in the drain once the stopped turn has ended.
            if (isBusy(yield* runOf(threadId))) yield* stop(threadId);
            else yield* startNext(threadId);
          }),
        );
      });

      /** The reply of the turn running in the thread, if any; fails when there is no such thread. */
      const runningReply = (threadId: ThreadId) =>
        findThread(threadId).pipe(
          Effect.andThen(runOf(threadId)),
          Effect.map((run) => run.reply),
        );

      const stop = Effect.fn("ChatService.stop")(function* (threadId: ThreadId) {
        const reply = yield* runningReply(threadId);
        if (reply === null) return;
        // Only the first request moves the reply to stopping and interrupts the turn.
        const requested = yield* transition(
          reply,
          (m) => (m.status === "streaming" ? MessageTransitions.requestStop(m) : undefined),
          saveMessage,
        );
        // Work the turn carried waits for you instead of starting again on its own.
        if (Option.isSome(requested) && reply.carries) yield* step(threadId, { _tag: "Hold" });
        // The turn records the confirmed outcome itself once the runtime has stopped.
        if (Option.isSome(requested)) yield* Effect.forkIn(FiberMap.remove(turns, threadId), scope);
      });

      // Stop waiting (#1056): only a reply waiting on commands ends this way; it shows as stopping until
      // the runtime has ended, then completes in the turn itself.
      const stopWaiting = Effect.fn("ChatService.stopWaiting")(function* (threadId: ThreadId) {
        const reply = yield* runningReply(threadId);
        if (reply === null) return;
        const requested = yield* transition(
          reply,
          (m) =>
            m.status === "streaming" && waitedSteps(m.steps).length > 0 ? MessageTransitions.requestStop(m) : undefined,
          saveMessage,
        );
        if (Option.isSome(requested)) yield* Deferred.succeed(reply.endWait, undefined);
      });

      // The reply streams again with the configuration the hob has now, like any new turn.
      const continueReply = Effect.fn("ChatService.continueReply")(function* (
        threadId: ThreadId,
        messageId: MessageId,
      ) {
        return yield* withThreadHob(threadId, (thread, agent) =>
          Effect.gen(function* () {
            // Continuing a reply goes on with work the hob has; while it retires, only that of an open Task.
            yield* requireAwake(agent);
            yield* requireOpenTaskWhileRetiring(agent, threadId);
            yield* requireLive(thread);
            const transcript = (yield* repo.listMessages(threadId)).filter((m) => m.status !== "queued");
            const message = transcript.at(-1);
            if (isBusy(yield* runOf(threadId)) || message?.id !== messageId || !isResumable(message.status)) {
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
      const threadRuns = Ref.get(runs).pipe(
        Effect.map(({ all, revision }) => ({
          revision,
          runs: Array.from(HashMap.entries(all)).flatMap(([threadId, run]) =>
            isBusy(run) ? [runStatus(threadId, run, revision)] : [],
          ),
        })),
      );
      const streamingReplies = Effect.suspend(() =>
        Ref.get(runs).pipe(
          Effect.flatMap(({ all }) =>
            Effect.forEach(
              Array.from(HashMap.values(all)).flatMap((run) => (run.reply === null ? [] : [run.reply])),
              (reply) => Ref.get(reply.current),
            ),
          ),
        ),
      ).pipe(Effect.map((messages) => messages.filter((message) => isInProgress(message.status))));
      const interruptAgent = Effect.fn("ChatService.interruptAgent")(function* (agentId: AgentId) {
        for (const threadId of yield* activeThreads) {
          const thread = yield* repo.findThread(threadId);
          if (Option.isSome(thread) && thread.value.agentId === agentId) yield* FiberMap.remove(turns, threadId);
        }
        if (Option.isSome(taskTurns)) yield* taskTurns.value.interruptAgent(agentId);
      });

      const reviewAuthority = Effect.fn("ChatService.reviewAuthority")(function* (agentId?: AgentId) {
        const narrowed = yield* grants.narrowed(agentId);
        // Outside the permit: a turn that is stopping may still be reading its grant.
        yield* Effect.forEach(narrowed, (threadId) => FiberMap.remove(turns, threadId), { discard: true });
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

      // What stops the thread from being archived now, which `ThreadLifecycle` weighs. Runs under the
      // hob's lock, so no turn starts and no message is sent while the thread is being archived.
      const archiveBlockers = (thread: Thread, agent: Agent) =>
        Effect.gen(function* () {
          const requests = Option.isSome(approvals) ? yield* approvals.value.listForThread(thread.id) : [];
          // A turn whose reply has ended no longer stops it, even before its thread is freed.
          const messages = yield* repo.listMessages(thread.id);
          return {
            hobRetired: agent.status === "retired",
            approvalPending: requests.some((request) => request.state === "pending"),
            replyRunning: messages.some((m) => m.status === "queued" || isInProgress(m.status)),
          };
        });

      // Runs the thread's lifecycle on the thread as stored, so a session a turn records meanwhile is
      // kept, and saves what it changes. A refusal fails as `ThreadArchiveRefused`; one with no reason
      // is a bug, as callers check the state first.
      const changeLifecycle = (thread: Thread, event: ThreadLifecycleEvent) =>
        Effect.gen(function* () {
          let refused: IllegalThreadTransition | undefined;
          const changed = yield* changeThread(thread.id, (latest) => {
            const next = ThreadLifecycle.transition(latest, event);
            if (next instanceof Thread) return next;
            refused = next;
            return null;
          });
          if (refused === undefined) return Option.getOrElse(changed, () => thread);
          if (refused.refusal === null) return yield* Effect.die(refused);
          return yield* new ThreadArchiveRefused({ threadId: thread.id, reason: refused.refusal });
        });

      const archive = Effect.fn("ChatService.archive")(function* (threadId: ThreadId) {
        return yield* withThreadHob(threadId, (thread, agent) =>
          Effect.gen(function* () {
            if (ThreadLifecycle.isArchived(thread)) return thread;
            const blockers = yield* archiveBlockers(thread, agent);
            return yield* changeLifecycle(thread, { _tag: "Archive", at: yield* nowIso, ...blockers });
          }),
        );
      });

      const restore = Effect.fn("ChatService.restore")(function* (threadId: ThreadId) {
        return yield* withThreadHob(
          threadId,
          (thread, agent) =>
            Effect.gen(function* () {
              if (!ThreadLifecycle.isArchived(thread)) return thread;
              const others = yield* repo.listThreads(thread.agentId);
              return yield* changeLifecycle(thread, {
                _tag: "Restore",
                hobRetired: agent.status === "retired",
                chatOpen: others.some((other) => other.id !== thread.id && ThreadLifecycle.isOpenChat(other)),
              });
            }),
          // Work that arrived while it was archived starts once it is back.
        ).pipe(Effect.tap(() => drainThreads([threadId])));
      });

      // Neither changes `updatedAt`, so a renamed or pinned chat keeps its place by last activity. Both
      // run under the hob's lock, so no archive lands between the check and the change.
      const changeLive = (threadId: ThreadId, change: (thread: Thread) => Thread | null) =>
        withThreadHob(threadId, (thread) =>
          Effect.gen(function* () {
            yield* requireLive(thread);
            return Option.getOrElse(yield* changeThread(threadId, change), () => thread);
          }),
        );

      const rename = Effect.fn("ChatService.rename")(function* (threadId: ThreadId, title: string) {
        return yield* changeLive(threadId, (latest) =>
          latest.title === title ? null : new Thread({ ...latest, title }),
        );
      });

      const setPinned = Effect.fn("ChatService.setPinned")(function* (threadId: ThreadId, pinned: boolean) {
        const now = yield* nowIso;
        return yield* changeLive(threadId, (latest) =>
          (latest.pinnedAt !== null) === pinned ? null : new Thread({ ...latest, pinnedAt: pinned ? now : null }),
        );
      });

      // Needs no hob lock: the marker moves forward in one statement, whatever else changes the thread.
      const markRead = Effect.fn("ChatService.markRead")(function* (
        threadId: ThreadId,
        messageId: MessageId,
        revision: number,
      ) {
        const thread = yield* findThread(threadId);
        const marked = yield* repo.markThreadRead(threadId, messageId, revision);
        return Option.isSome(marked) ? yield* announce(marked.value) : thread;
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
        yield* Effect.forEach(own, (threadId) => step(threadId, { _tag: "Release" }));
        yield* drainThreads(own);
        if (Option.isSome(taskTurns)) yield* taskTurns.value.drainAgent(agentId);
      });

      const wake = (threadId: ThreadId) => drainThreads([threadId]);
      const resume = (threadId: ThreadId) => step(threadId, { _tag: "Release" }).pipe(Effect.andThen(wake(threadId)));

      // Messages queued and work left waiting before a restart start again, through the same path
      // as any other.
      yield* drainThreads(yield* threadsWaiting());

      return ChatService.of({
        createThread,
        sendPrompt,
        removeQueued,
        sendNow,
        stop,
        stopWaiting,
        continueReply,
        interruptAgent,
        reviewAuthority,
        setBrain,
        checkBrainSwitch,
        followHob,
        archive,
        rename,
        setPinned,
        markRead,
        restore,
        drainAgent,
        wake,
        resume,
        activeThreads,
        threadRuns,
        streamingReplies,
      });
    }),
  );
}
