import {
  AgentNotFound,
  HobUnavailable,
  type InvalidHob,
  MessageNotQueued,
  ReplyNotResumable,
  type StartFreshRefused,
  ThreadArchived,
  type ThreadArchiveRefused,
  type ThreadKeyReused,
  type ThreadNotCamp,
  ThreadNotFound,
} from "@hobbots/api";
import {
  type Agent,
  AgentId,
  type Brain,
  type ChapterId,
  type ChapterMove,
  type ChapterNotFound,
  type ChapterRefused,
  type Committed,
  DEFAULT_THREAD_TITLE,
  hobReads,
  hobStanding,
  type IllegalChapterTransition,
  isResumable,
  type MentionRefused,
  Message,
  MessageId,
  MessageTransitions,
  mainLine,
  openThreadTask,
  type PackReport,
  type SkillMention,
  type SkillTrial,
  type StartedFresh,
  Thread,
  ThreadId,
  ThreadLifecycle,
  type ThreadMember,
  type ThreadRunStatus,
  type TurnRequest,
  type TurnRequestId,
  TurnRequests,
  takesNewWork,
  type UnreadThreads,
  waitedSteps,
} from "@hobbots/domain";
import { Context, DateTime, Deferred, Effect, Layer, Option, Semaphore } from "effect";
import { HobAdmission } from "./admission.ts";
import { type CampRequest, type MoveRequest, makeCampCommands } from "./camp-commands.ts";
import { buildPack, type Pack } from "./context-pack.ts";
import { Continuations } from "./continuations.ts";
import { EventPublisher } from "./ports.ts";
import { HobbotsRepository } from "./repository.ts";
import { makeRedactor, SecretRedaction } from "./secrets.ts";
import { mentionedSkill, namedSkills } from "./skill-turn.ts";
import { uncertainCalls } from "./steps.ts";
import { TaskTurns } from "./task-turns.ts";
import { TaskRepository } from "./tasks.ts";
import { makeThreadCommands } from "./thread-commands.ts";
import { isBusy } from "./thread-run.ts";
import { brainFor, makeThreadRunner } from "./thread-runner.ts";
import { HobTools } from "./tools.ts";
import { makeTurnGrants } from "./turn-grants.ts";
import { makeTurnInputs } from "./turn-inputs.ts";
import { makePackSources, PackReports } from "./turn-pack.ts";
import { sessionActor } from "./users.ts";

/**
 * The skill a message asks for: the one you picked with `/`, or one its text names. A skill of a set
 * picked by its name alone is recorded with its set, when that names one.
 */
const pickedSkill = (
  content: string,
  askedSkill: SkillMention | null,
  named: Parameters<typeof mentionedSkill>[1],
): SkillMention | null =>
  askedSkill === null ? mentionedSkill(content, named) : (mentionedSkill(`/${askedSkill}`, named) ?? askedSkill);

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
      ThreadNotFound | HobUnavailable | ThreadArchived | MentionRefused
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
     * Stop all (ADR 039, One hob speaks at a time): stops the turn speaking in the thread and drops
     * every request still owed there, each recording who stopped it. Work in the backpack is never
     * dropped.
     */
    readonly stopAll: (threadId: ThreadId) => Effect.Effect<void, ThreadNotFound>;
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
     * Makes a camp private, or public again (ADR 037): from then on, memory capture takes nothing it
     * writes while private, and what it captured before stays. Refused for a chat and while archived.
     */
    readonly setPrivate: (
      threadId: ThreadId,
      value: boolean,
    ) => Effect.Effect<Thread, ThreadNotFound | ThreadArchived | ThreadNotCamp>;
    /**
     * Records that the person asking read the thread through `messageId`, as they saw it at
     * `revision` (ADR 027), so its unread dot clears on every device of theirs: their member row,
     * with its marker moved (ADR 039). The marker only moves forward: a message they had read past,
     * or one from another thread, returns null. An archived thread takes it too.
     */
    readonly markRead: (
      threadId: ThreadId,
      messageId: MessageId,
      revision: number,
    ) => Effect.Effect<ThreadMember | null, ThreadNotFound>;
    /** The threads where a hob wrote since the person asking last read them (ADR 039). */
    readonly unreadThreads: Effect.Effect<UnreadThreads>;
    /** Restores an archived thread, unless its hob is retired. Restoring a live thread returns it unchanged. */
    readonly restore: (threadId: ThreadId) => Effect.Effect<Thread, ThreadNotFound | ThreadArchiveRefused>;
    /**
     * Makes a camp for the hob, with a title, a goal and whether it is private (ADR 037). Its key
     * becomes the camp's id: the same camp asked for again is returned unchanged, and a key that
     * names another thread is refused. Refused for a hob that takes no new work.
     */
    readonly makeCamp: (
      agentId: AgentId,
      request: CampRequest,
    ) => Effect.Effect<Thread, AgentNotFound | HobUnavailable | ThreadKeyReused>;
    /**
     * Starts the hob's chat fresh (ADR 037): the chat is superseded and a new one opens under `key`,
     * with what the old one still owed moved into it. Refused for a thread that is not its hob's open
     * chat, and for what stops an archive. The same request sent again returns what it did.
     */
    readonly startFresh: (
      threadId: ThreadId,
      key: ThreadId,
    ) => Effect.Effect<StartedFresh, ThreadNotFound | StartFreshRefused | ThreadKeyReused>;
    /**
     * Moves a chapter into a camp (ADR 037, #1385): an open camp of the hob's, or a new one made from
     * it under `key`, whose origin is the thread and chapter. Its messages, decisions, artifacts and
     * the quests started in it go along, and the thread keeps a stub. Refused while a reply runs or
     * an approval waits in either thread. The same move asked again returns what it did.
     */
    readonly moveChapter: (
      threadId: ThreadId,
      chapterId: ChapterId,
      request: MoveRequest,
    ) => Effect.Effect<
      ChapterMove,
      ThreadNotFound | HobUnavailable | ThreadKeyReused | ChapterRefused | ChapterNotFound | IllegalChapterTransition
    >;
    /**
     * The context pack the thread's next new session would start from, and the report of the pack
     * its last such turn read, if the hub kept one (ADR 037, #1380). The dev-only endpoint shows both.
     */
    readonly contextPack: (
      threadId: ThreadId,
    ) => Effect.Effect<{ readonly next: Pack; readonly lastTurn: PackReport | null }, ThreadNotFound>;
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
     * Every line whose run is not idle or has hobs waiting for its floor, as `ThreadRunChanged`
     * publishes it, and the revision of the last transition of any run: a line left out is idle with
     * nobody waiting as of that revision (ADR 037, ADR 039).
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
      const admission = yield* HobAdmission;
      const hobTools = yield* HobTools;
      // Without the hub's redactor, secret shapes are still redacted.
      const redactor = Option.getOrElse(yield* Effect.serviceOption(SecretRedaction), () => makeRedactor());
      // Without Task work, turns offer no Task tools and hobs run no steps.
      const taskTurns = yield* Effect.serviceOption(TaskTurns);
      const taskRecords = yield* Effect.serviceOption(TaskRepository);
      const inputs = yield* makeTurnInputs(repo, hobTools, redactor);
      const { acceptedIn } = inputs;
      // Without a backpack, a thread starts only your queued messages.
      const continuations = yield* Effect.serviceOption(Continuations);
      // After a restore nothing that waited starts on its own until you resume work (ADR 026).
      const scope = yield* Effect.scope;
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
      // asked to stop is stopped; any other is interrupted. Its interrupted reply answers the request
      // it spoke for, which Continue resumes, so the floor does not start it again.
      for (const message of yield* repo.listUnfinishedMessages) {
        const next = MessageTransitions.interrupt(message);
        if (next instanceof Message) yield* saveMessage(next);
      }
      yield* repo.answerUnfinishedTurnRequests;

      // A queued message's start and removal write, then announce the change once it is committed (CH-008).
      const saveStarted = (message: Message, reply: Message, speaking: ReadonlyArray<TurnRequestId>) =>
        repo.startQueuedMessage(message, reply, speaking).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.succeed(null),
              onSome: (committed) => announce(committed).pipe(Effect.map((saved) => saved.reply)),
            }),
          ),
        );
      // A turn's reply, saved with the requests it answers taking the floor (ADR 039).
      const saveSpeaking = (reply: Message, speaking: ReadonlyArray<TurnRequestId>) =>
        repo
          .startReply(reply, speaking)
          .pipe(
            Effect.flatMap(
              Option.match({ onNone: () => Effect.succeed(null), onSome: (committed) => announce(committed) }),
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

      // Reads the hob under its lock, so a pause or retirement cannot slip in before `body` ends.
      const withHob = <A, E, R>(agentId: AgentId, body: (agent: Agent) => Effect.Effect<A, E, R>) =>
        admission.withHob(
          agentId,
          Effect.gen(function* () {
            const agent = yield* repo.findAgent(agentId);
            if (Option.isNone(agent)) return yield* new AgentNotFound({ agentId });
            return yield* body(agent.value);
          }),
        );

      // Status is read under the hob's lock, so a pause or retirement cannot slip in before the thread is saved.
      const createThread = Effect.fn("ChatService.createThread")(function* (
        agentId: AgentId,
        options: { readonly title?: string; readonly skillTrial?: SkillTrial } = {},
      ) {
        return yield* withHob(agentId, (agent) =>
          Effect.gen(function* () {
            yield* requireActive(agent);
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

      const grants = yield* makeTurnGrants(repo, hobTools);
      const {
        runOf,
        step,
        transition,
        beginTurn,
        launch,
        startNext,
        lineUp,
        drainThreads,
        endTurn,
        workRidesAlong,
        activeThreads,
        threadRuns,
        streamingReplies,
      } = yield* makeThreadRunner({
        redactor,
        grants,
        inputs,
        saveMessage,
        announce,
        changeThread,
        saveStarted,
        saveSpeaking,
      });

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

      // The hob that takes the floor now for a request of `hobId`: the thread's own hob, read under
      // its lock, or another member hob that takes work; null while it cannot speak.
      const speakerFor = (hobId: AgentId, own: Agent) =>
        Effect.gen(function* () {
          if (hobId === own.id) return own.status === "active" ? own : null;
          const hob = yield* repo.findAgent(hobId);
          return Option.isSome(hob) && hob.value.status === "active" ? hob.value : null;
        });

      // Drops what `pick` chooses among the line's requests still owed, as the person stopping.
      const dropOwed = (threadId: ThreadId, pick: (open: ReadonlyArray<TurnRequest>) => ReadonlyArray<TurnRequest>) =>
        Effect.gen(function* () {
          const dropping = pick(yield* repo.openTurnRequests(mainLine(threadId)));
          if (dropping.length === 0) return;
          const by = yield* sessionActor;
          yield* repo
            .dropTurnRequests(
              dropping.map((request) => request.id),
              by,
            )
            .pipe(Effect.flatMap(announce));
          yield* lineUp(threadId);
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
            // A message waits while its hob is paused, while a reply runs, and behind any request
            // already waiting for the floor, so the thread's messages start in the order they were
            // sent (CH-008, ADR 039). It is stored and shown at once either way.
            const busy = isBusy(yield* runOf(threadId));
            const lined = TurnRequests.waiting(yield* repo.openTurnRequests(mainLine(threadId))).length > 0;
            const waits = agent.status === "paused" || busy || lined;
            // Work you stopped here, and routine progress, ride along: the message starts through the
            // dispatcher, under their claims.
            const carries = !waits && (yield* workRidesAlong(threadId, agent.id));
            const accepted = yield* acceptedIn(thread, agent);
            const named = namedSkills(accepted, thread.skillTrial);
            const userMessage = new Message({
              id: MessageId.make(crypto.randomUUID()),
              threadId,
              actor: yield* sessionActor,
              role: "user",
              content,
              status: waits || carries ? "queued" : "complete",
              error: null,
              configVersion: null,
              skills: accepted,
              askedSkill: pickedSkill(content, askedSkill, named),
              createdAt: yield* nowIso,
            });
            // Who answers is decided in the transaction that stores the message (ADR 039, Who
            // answers), from the mentions the hub parses in its text: a mention of a hob that cannot
            // hear it refuses the message, and nothing is stored.
            // Each hob that owes it an answer gets a `TurnRequest`, written with it.
            const sent = yield* repo.sendMessage(userMessage, { mentions: [], repliesTo: null });
            const saved = yield* announce(sent).pipe(Effect.map((value) => value.message));
            const [first] = sent.value.requests;
            if (first === undefined) return { userMessage: saved, assistantMessage: null };
            // Work you stopped in this thread may start again once this message is answered.
            yield* step(threadId, { _tag: "Release" });
            if (carries) yield* startNext(threadId);
            const speaker = waits || carries ? null : yield* speakerFor(first.hobId, agent);
            if (speaker === null) {
              // A line left idle behind a request its hob cannot take yet gives the floor to the
              // next one that can.
              if (!busy && !carries) yield* startNext(threadId);
              yield* lineUp(threadId);
              return { userMessage: saved, assistantMessage: null };
            }
            // The first hob it is owed by takes the floor at once; the others wait their turn.
            const begun = yield* beginTurn(thread, speaker, saved, (reply) => saveSpeaking(reply, [first.id]));
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
            yield* lineUp(threadId);
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
        if (Option.isNone(requested)) return;
        // The turn's request, and those its mentions caused, are dropped with it; a person's stay.
        // Only this reply's: a turn that started since keeps its own.
        yield* dropOwed(threadId, (open) =>
          TurnRequests.speaking(open)?.replyId === requested.value.id ? TurnRequests.stopping(open) : [],
        );
        // The turn records the confirmed outcome itself once the runtime has stopped.
        yield* Effect.forkIn(
          runOf(threadId).pipe(Effect.flatMap((run) => (run.reply === reply ? endTurn(threadId) : Effect.void))),
          scope,
        );
      });

      // Stop all (ADR 039): stops the turn that is speaking and drops every request still owed in
      // the line, each recording who stopped it. A queued message left with nothing owed stays said.
      // What is owed is dropped first, so the stopped turn's end finds nothing to start next.
      const stopAll = Effect.fn("ChatService.stopAll")(function* (threadId: ThreadId) {
        yield* dropOwed(threadId, TurnRequests.stoppingAll);
        yield* stop(threadId);
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
        return yield* withThreadHob(threadId, (thread, own) =>
          Effect.gen(function* () {
            // A note to self written since does not stand in the way: the hob never reads it.
            const transcript = (yield* repo.listMessages(threadId)).filter((m) => m.status !== "queued" && hobReads(m));
            const message = transcript.at(-1);
            // The hob that wrote the reply goes on with it, in a camp it joined too.
            const author =
              message?.actor?.kind === "hob" && message.actor.id !== own.id
                ? yield* repo.findAgent(AgentId.make(message.actor.id))
                : Option.some(own);
            if (Option.isNone(author)) return yield* new ReplyNotResumable({ messageId });
            const agent = author.value;
            // Continuing a reply goes on with work the hob has; while it retires, only that of an open Task.
            yield* requireAwake(agent);
            yield* requireOpenTaskWhileRetiring(agent, threadId);
            yield* requireLive(thread);
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

      const interruptAgent = Effect.fn("ChatService.interruptAgent")(function* (agentId: AgentId) {
        // The hob's turns are those where it holds the floor, in its own threads or in camps it joined.
        for (const threadId of yield* activeThreads) {
          if ((yield* runOf(threadId)).speaking === agentId) yield* endTurn(threadId);
        }
        if (Option.isSome(taskTurns)) yield* taskTurns.value.interruptAgent(agentId);
      });

      const reviewAuthority = Effect.fn("ChatService.reviewAuthority")(function* (agentId?: AgentId) {
        const narrowed = yield* grants.narrowed(agentId);
        // Outside the permit: a turn that is stopping may still be reading its grant.
        yield* Effect.forEach(narrowed, (threadId) => endTurn(threadId), { discard: true });
        if (Option.isSome(taskTurns)) yield* taskTurns.value.reviewAuthority(agentId);
      });

      const { checkBrainSwitch, followHob, setBrain, archive, restore, rename, setPinned, setPrivate, markRead } =
        yield* makeThreadCommands({
          findThread,
          requireActive,
          requireLive,
          withThreadHob,
          changeThread,
          announce,
          drainThreads,
        });
      const { makeCamp, startFresh, moveChapter } = yield* makeCampCommands({
        requireActive,
        withHob,
        withThreadHob,
        announce,
      });

      // The threads with requests or your queued messages or backpack work waiting: of one hob, or
      // of every hob. Requests are the floor's queue, rebuilt from the records at start (ADR 039).
      const threadsWaiting = (agentId?: AgentId) =>
        Effect.gen(function* () {
          const queued = [...(yield* repo.threadsWithQueuedMessages), ...(yield* repo.threadsWithWaitingRequests)];
          const work = Option.isSome(continuations) ? yield* continuations.value.waiting(agentId) : [];
          return [...new Set([...queued, ...work])];
        });

      const drainAgent = Effect.fn("ChatService.drainAgent")(function* (agentId: AgentId) {
        // A hob that wakes takes up the work you stopped in its threads too.
        const threads = yield* threadsWaiting(agentId);
        const own = yield* Effect.filter(threads, (threadId) =>
          repo.findThread(threadId).pipe(Effect.map((t) => Option.isSome(t) && t.value.agentId === agentId)),
        );
        // And the requests it owes in camps it joined, which wait for it there.
        const owed = yield* Effect.filter(threads, (threadId) =>
          repo
            .openTurnRequests(mainLine(threadId))
            .pipe(Effect.map((open) => TurnRequests.waiting(open).some((request) => request.hobId === agentId))),
        );
        yield* Effect.forEach(own, (threadId) => step(threadId, { _tag: "Release" }));
        yield* drainThreads([...new Set([...own, ...owed])]);
        if (Option.isSome(taskTurns)) yield* taskTurns.value.drainAgent(agentId);
      });

      const wake = (threadId: ThreadId) => drainThreads([threadId]);
      const resume = (threadId: ThreadId) => step(threadId, { _tag: "Release" }).pipe(Effect.andThen(wake(threadId)));

      const packSources = yield* makePackSources;
      const packReports = yield* Effect.serviceOption(PackReports);
      const contextPack = (threadId: ThreadId) =>
        Effect.gen(function* () {
          const thread = yield* repo.findThread(threadId);
          if (Option.isNone(thread)) return yield* new ThreadNotFound({ threadId });
          const transcript = (yield* repo.listMessages(threadId)).filter((m) => m.status !== "queued" && hobReads(m));
          const live = transcript.filter((m) => m.chapterId === thread.value.liveChapterId);
          const sources = yield* packSources(thread.value, live, transcript);
          const agent = yield* repo.findAgent(thread.value.agentId);
          const memory = Option.isNone(agent)
            ? null
            : yield* inputs.memoryBriefFor(agent.value, yield* hobTools.access(agent.value), undefined);
          const lastTurn = Option.isNone(packReports) ? Option.none() : yield* packReports.value.last(threadId);
          return {
            next: buildPack({ ...sources, memoryBrief: memory?.text ?? null }),
            lastTurn: Option.getOrNull(lastTurn),
          };
        });

      // Messages queued and work left waiting before a restart start again, through the same path
      // as any other.
      yield* drainThreads(yield* threadsWaiting());

      return ChatService.of({
        createThread,
        sendPrompt,
        removeQueued,
        sendNow,
        stop,
        stopAll,
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
        setPrivate,
        markRead,
        unreadThreads: repo.listUnreadThreads,
        restore,
        makeCamp,
        startFresh,
        moveChapter,
        contextPack,
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
