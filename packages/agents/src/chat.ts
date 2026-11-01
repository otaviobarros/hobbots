import {
  AgentNotFound,
  HobUnavailable,
  type InvalidHob,
  MessageNotQueued,
  ReplyNotResumable,
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
import { checkRuntimeBrain } from "./hobs.ts";
import { EventPublisher } from "./ports.ts";
import { HobbotsRepository } from "./repository.ts";
import { type RuntimeEvent, runtimeAdapters, type ToolAccess } from "./runtime.ts";
import { nextSteps } from "./steps.ts";
import { HobTools, narrows } from "./tools.ts";

interface Reply {
  readonly current: Ref.Ref<Message>;
  readonly lock: Semaphore.Semaphore;
  /** How many steps the reply had from earlier turns when Continue resumed it; this turn's come after. */
  readonly stepsFrom: number;
  /** The text the reply already had when Continue resumed it; the runtime's final text comes after it. */
  readonly prefix: string;
}

/** How much of a cut-off reply the runtime is shown when asked to continue it. */
const CONTINUE_CONTEXT = 4_000;

/** The prompt that resumes a reply that ended early, so the runtime picks up where it left off. */
const continuePrompt = (content: string) =>
  [
    "Your previous reply was cut off before it finished. It ends with this text:",
    "",
    content.slice(-CONTINUE_CONTEXT),
    "",
    "Continue from exactly where it stops. Do not repeat what is already written.",
  ].join("\n");

const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

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
    ) => Effect.Effect<{ userMessage: Message; assistantMessage: Message | null }, ThreadNotFound | HobUnavailable>;
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
    ) => Effect.Effect<Message, ThreadNotFound | HobUnavailable | ReplyNotResumable>;
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
    ) => Effect.Effect<Thread, ThreadNotFound | HobUnavailable | InvalidHob>;
    /** Starts the hob's queued messages in threads with no turn running, as when it wakes. */
    readonly drainAgent: (agentId: AgentId) => Effect.Effect<void>;
    /** Threads with a turn in progress in this process. */
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
      const turns = yield* FiberMap.make<ThreadId>();
      const scope = yield* Effect.scope;
      // The reply each running turn is writing, so a stop request can reach it.
      const replies = new Map<ThreadId, Reply>();
      // Threads with a turn running or just ended and not yet drained. In-process, as turns are;
      // the queue itself is the stored queued messages.
      const busy = new Set<ThreadId>();
      // The queued message Send now picked to start next in each thread.
      const chosen = new Map<ThreadId, MessageId>();

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
      const currentAccess = (agentId: AgentId) =>
        repo
          .findAgent(agentId)
          .pipe(
            Effect.flatMap(
              Option.match({ onNone: () => Effect.succeed(null), onSome: (agent) => hobTools.access(agent) }),
            ),
          );
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

          const handle = (event: RuntimeEvent) => {
            switch (event._tag) {
              // The session has now seen the thread through this reply.
              case "SessionStarted":
                return Effect.gen(function* () {
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
              // Steps, a tool call's included, are saved with the reply, so they replay on reconnect.
              default:
                return update((m) => {
                  const steps = nextSteps(m.steps, reply.stepsFrom, event);
                  return steps === null ? undefined : MessageTransitions.setSteps(m, steps);
                });
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
          yield* adapter
            .sendPrompt({
              prompt,
              briefing,
              sessionId: thread.sessions.find((s) => s.runtime === brain.runtime)?.sessionId ?? null,
              instructions: systemInstructions(name, config),
              instructionsChanged: changed,
              model: brain.model,
              effort: brain.effort,
              tools: yield* grant(thread.id, agent),
              approvals: turnApprovals?.approvals ?? null,
            })
            .pipe(
              Stream.runForEach(handle),
              Effect.catchTags({
                RuntimeError: (error) => update((m) => MessageTransitions.cutOff(m, error.message)),
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

      // Starts a turn for a prompt that is already stored. Runs under the hob's lock; the thread is
      // busy from here until the turn's drain releases it, so later prompts queue behind it.
      // `saveReply` stores the new streaming reply; the turn starts only once it is saved.
      const beginTurn = (
        thread: Thread,
        agent: Agent,
        prompt: Message,
        saveReply: (reply: Message) => Effect.Effect<Message | null> = saveMessage,
      ) =>
        Effect.gen(function* () {
          const config = yield* repo.findAgentConfig(agent.id, agent.configVersion).pipe(Effect.map(Option.getOrThrow));
          const brain = brainFor(thread, config);
          const now = yield* nowIso;
          const assistantMessage = new Message({
            id: MessageId.make(crypto.randomUUID()),
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
          const updated = yield* changeThread(thread.id, (latest) =>
            latest.title === DEFAULT_THREAD_TITLE
              ? new Thread({ ...latest, title: titleFromPrompt(prompt.content), updatedAt: now })
              : new Thread({ ...latest, updatedAt: now }),
          ).pipe(Effect.map(Option.getOrElse(() => thread)));
          yield* launch(agent, config, updated, prompt.content, saved, prompt.id);
          return saved;
        });

      // Runs a turn for a reply that is already saved as streaming, on the thread's brain, with what
      // its session missed told first. `promptId` is the turn's own prompt, when it is a message;
      // `continuedFrom` the brain that wrote a reply Continue resumes.
      // Runs under the hob's lock.
      const launch = (
        agent: Agent,
        config: AgentConfiguration,
        thread: Thread,
        prompt: string,
        saved: Message,
        promptId: MessageId | null,
        continuedFrom: RuntimeKind | null = null,
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
          const switched = continuedFrom !== null && continuedFrom !== brain.runtime;
          const briefing = yield* brief(thread, brain.runtime, before, switched);
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
          };
          replies.set(thread.id, reply);
          // The drain is forked outside the turn: it waits for the hob's lock, which a retirement
          // may hold while it waits for this very turn to stop.
          yield* FiberMap.run(
            turns,
            thread.id,
            runTurn(agent, config, thread, brain, prompt, briefing, reply, changed).pipe(
              Effect.ensuring(Effect.forkIn(drain(thread.id), scope)),
            ),
          );
        });

      // Starts the thread's next queued message, if its hob takes work: the one chosen with Send now,
      // else the one that has waited longest. Runs under the hob's lock while the thread is not busy.
      const startNext = (threadId: ThreadId): Effect.Effect<void> =>
        Effect.gen(function* () {
          const thread = yield* repo.findThread(threadId);
          if (Option.isNone(thread)) return;
          const agent = yield* repo.findAgent(thread.value.agentId);
          if (Option.isNone(agent) || agent.value.status !== "active") return;
          const queued = (yield* repo.listMessages(threadId)).filter((m) => m.status === "queued");
          const next = queued.find((m) => m.id === chosen.get(threadId)) ?? queued[0];
          chosen.delete(threadId);
          if (next === undefined) return;
          const started = QueuedMessageTransitions.start(next);
          if (!(started instanceof Message)) return;
          // The message starts together with its reply, so a crash cannot leave it started but unanswered.
          yield* beginTurn(thread.value, agent.value, started, (reply) => saveStarted(started, reply));
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

      // Starts each idle thread's queued messages: after a restart, or when a paused hob wakes.
      const drainThreads = (threadIds: ReadonlyArray<ThreadId>) =>
        Effect.forEach(threadIds, (threadId) =>
          repo.findThread(threadId).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.void,
                onSome: (thread) =>
                  admission.withHob(
                    thread.agentId,
                    Effect.suspend(() => (busy.has(threadId) ? Effect.void : startNext(threadId))),
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

      const sendPrompt = Effect.fn("ChatService.sendPrompt")(function* (threadId: ThreadId, content: string) {
        // The status check and the turn's registration happen under the hob's lock, so a turn is
        // either admitted before a retirement (which then sees and stops it) or refused after it.
        return yield* withThreadHob(threadId, (thread, agent) =>
          Effect.gen(function* () {
            // A retired hob takes nothing; a paused one keeps messages queued until it wakes.
            if (agent.status === "retired") yield* requireActive(agent);
            // A message waits while its hob is paused, while a reply runs, and behind any message
            // already waiting, so the thread's messages start in the order they were sent (CH-008).
            const waits =
              agent.status === "paused" || busy.has(threadId) || Option.isSome(yield* repo.nextQueuedMessage(threadId));
            const userMessage = new Message({
              id: MessageId.make(crypto.randomUUID()),
              threadId,
              role: "user",
              content,
              status: waits ? "queued" : "complete",
              error: null,
              configVersion: null,
              createdAt: yield* nowIso,
            });
            const saved = yield* saveMessage(userMessage);
            if (waits) return { userMessage: saved, assistantMessage: null };
            const assistantMessage = yield* beginTurn(thread, agent, saved);
            return { userMessage: saved, assistantMessage };
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
            yield* launch(agent, config, thread, continuePrompt(message.content), saved, null, message.runtime);
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
      });

      const setBrain = Effect.fn("ChatService.setBrain")(function* (threadId: ThreadId, brain: Brain | null) {
        return yield* withThreadHob(threadId, (thread, agent) =>
          Effect.gen(function* () {
            if (agent.status === "retired") yield* requireActive(agent);
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

      const drainAgent = Effect.fn("ChatService.drainAgent")(function* (agentId: AgentId) {
        const threads = yield* repo.threadsWithQueuedMessages;
        const own = yield* Effect.filter(threads, (threadId) =>
          repo.findThread(threadId).pipe(Effect.map((t) => Option.isSome(t) && t.value.agentId === agentId)),
        );
        yield* drainThreads(own);
      });

      // Messages queued before a restart start again, through the same path as any other.
      yield* drainThreads(yield* repo.threadsWithQueuedMessages);

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
        drainAgent,
        activeThreads,
        streamingReplies,
      });
    }),
  );
}
