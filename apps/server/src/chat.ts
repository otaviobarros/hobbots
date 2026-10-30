import { AgentNotFound, HobUnavailable, MessageNotQueued, ThreadNotFound } from "@hobbots/api";
import {
  type Agent,
  type AgentConfiguration,
  type AgentId,
  DEFAULT_THREAD_TITLE,
  type HobbotsEvent,
  Message,
  MessageId,
  MessageTransitions,
  QueuedMessageTransitions,
  Thread,
  ThreadId,
  titleFromPrompt,
} from "@hobbots/domain";
import { HobbotsRepository } from "@hobbots/persistence";
import { RuntimeAdapter, type RuntimeEvent } from "@hobbots/runtimes";
import { Context, DateTime, Effect, Fiber, FiberMap, Layer, Option, Ref, Semaphore, Stream } from "effect";
import { HobAdmission } from "./admission.ts";
import { EventBus } from "./event-bus.ts";

/** The events a saved message produces: always its upsert, then that it queued or any stop outcome it records. */
const messageEvents = (message: Message): ReadonlyArray<HobbotsEvent> => {
  const ids = { threadId: message.threadId, messageId: message.id };
  const upserted: HobbotsEvent = { _tag: "MessageUpserted", message };
  switch (message.status) {
    case "queued":
      return [upserted, { _tag: "MessageQueued", message }];
    case "stopping":
      return [upserted, { _tag: "TurnStopRequested", ...ids }];
    case "stopped":
      return [upserted, { _tag: "TurnStopped", ...ids }];
    default:
      return [upserted];
  }
};

interface Reply {
  readonly current: Ref.Ref<Message>;
  readonly lock: Semaphore.Semaphore;
}

const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

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
    /** Stops every turn the hob has in progress and waits until each has ended (stopped if the user had asked, otherwise interrupted). */
    readonly interruptAgent: (agentId: AgentId) => Effect.Effect<void>;
    /** Starts the hob's queued messages in threads with no turn running, as when it wakes. */
    readonly drainAgent: (agentId: AgentId) => Effect.Effect<void>;
    /** Threads with a turn in progress in this process. */
    readonly activeThreads: Effect.Effect<ReadonlyArray<ThreadId>>;
  }
>()("@hobbots/server/ChatService") {
  static readonly layer = Layer.effect(
    ChatService,
    Effect.gen(function* () {
      const repo = yield* HobbotsRepository;
      const bus = yield* EventBus;
      const runtime = yield* RuntimeAdapter;
      const admission = yield* HobAdmission;
      const turns = yield* FiberMap.make<ThreadId>();
      const scope = yield* Effect.scope;
      // The reply each running turn is writing, so a stop request can reach it.
      const replies = new Map<ThreadId, Reply>();
      // Threads with a turn running or just ended and not yet drained. In-process, as turns are;
      // the queue itself is the stored queued messages.
      const busy = new Set<ThreadId>();
      // The queued message Send now picked to start next in each thread.
      const chosen = new Map<ThreadId, MessageId>();

      const publishMessage = (message: Message) =>
        Effect.forEach(messageEvents(message), bus.publish, { discard: true });

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

      const saveThread = (thread: Thread) =>
        repo.upsertThread(thread).pipe(Effect.andThen(bus.publish({ _tag: "ThreadUpserted", thread })));

      // Every message write goes through here so its events follow the commit in a fixed order.
      const saveMessage = (message: Message) =>
        repo.upsertMessage(message).pipe(Effect.andThen(publishMessage(message)));

      // A previous process may have died mid-turn; those turns cannot resume. A reply the user had
      // asked to stop is stopped; any other is interrupted.
      for (const message of yield* repo.listUnfinishedMessages) {
        const next = MessageTransitions.interrupt(message);
        if (next instanceof Message) yield* saveMessage(next);
      }

      // A queued message's start and removal write, then announce the change once it is committed (CH-008).
      const saveStarted = (message: Message, reply: Message) =>
        Effect.gen(function* () {
          if (!(yield* repo.startQueuedMessage(message, reply))) return false;
          yield* publishMessage(message);
          yield* bus.publish({
            _tag: "MessageDequeued",
            threadId: message.threadId,
            messageId: message.id,
            reason: "started",
          });
          yield* publishMessage(reply);
          return true;
        });
      const saveRemoved = (threadId: ThreadId, messageId: MessageId) =>
        Effect.gen(function* () {
          if (!(yield* repo.removeQueuedMessage(threadId, messageId))) return false;
          yield* bus.publish({ _tag: "MessageDequeued", threadId, messageId, reason: "removed" });
          return true;
        });

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
              runtimeSessionId: null,
              createdAt: now,
              updatedAt: now,
            });
            yield* saveThread(thread);
            return thread;
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

      // The turn runs with the configuration it started with; edits made meanwhile apply to the next turn.
      const runTurn = (config: AgentConfiguration, thread: Thread, prompt: string, reply: Reply) =>
        Effect.gen(function* () {
          const threadRef = yield* Ref.make(thread);
          const update = (f: (message: Message) => Message | unknown) => transition(reply, f, saveMessage);

          const handle = (event: RuntimeEvent) => {
            switch (event._tag) {
              case "SessionStarted":
                return Effect.gen(function* () {
                  const latest = yield* Ref.get(threadRef);
                  if (latest.runtimeSessionId === event.sessionId) return;
                  const next = new Thread({
                    ...latest,
                    runtimeSessionId: event.sessionId,
                    updatedAt: yield* nowIso,
                  });
                  yield* Ref.set(threadRef, next);
                  yield* saveThread(next);
                  if (event.billing && !event.billing.startsWith("subscription") && event.billing !== "fake") {
                    yield* Effect.logWarning(`Claude Code is billing via ${event.billing}, not the subscription`);
                  }
                });
              case "TextDelta":
                return transition(
                  reply,
                  (m) => MessageTransitions.appendDelta(m, event.text),
                  (m) =>
                    bus.publish({ _tag: "MessageDelta", threadId: m.threadId, messageId: m.id, delta: event.text }),
                );
              case "Completed":
                return update((m) => MessageTransitions.complete(m, event.text));
            }
          };

          yield* runtime
            .sendPrompt({
              prompt,
              sessionId: thread.runtimeSessionId,
              instructions: config.instructions,
              model: config.model,
              effort: config.effort,
            })
            .pipe(
              Stream.runForEach(handle),
              Effect.catchTag("RuntimeError", (error) => update((m) => MessageTransitions.fail(m, error.message))),
            );
          // The stream ended without a result: treat it as a failure, not a silent success.
          yield* update((m) => MessageTransitions.fail(m, "Runtime ended without a result"));
        }).pipe(
          // Runs after the runtime's stream has closed, so "stopped" means the turn really ended.
          Effect.onInterrupt(() => transition(reply, MessageTransitions.interrupt, saveMessage)),
          Effect.ensuring(
            Effect.sync(() => {
              if (replies.get(thread.id) === reply) replies.delete(thread.id);
            }),
          ),
        );

      // Starts a turn for a prompt that is already stored. Runs under the hob's lock; the thread is
      // busy from here until the turn's drain releases it, so later prompts queue behind it.
      // `saveReply` stores the new streaming reply; the turn starts only once it is saved.
      const beginTurn = (
        thread: Thread,
        agent: Agent,
        prompt: string,
        saveReply: (reply: Message) => Effect.Effect<boolean> = (reply) => Effect.as(saveMessage(reply), true),
      ) =>
        Effect.gen(function* () {
          const config = yield* repo.findAgentConfig(agent.id, agent.configVersion).pipe(Effect.map(Option.getOrThrow));
          const now = yield* nowIso;
          const assistantMessage = new Message({
            id: MessageId.make(crypto.randomUUID()),
            threadId: thread.id,
            role: "assistant",
            content: "",
            status: "streaming",
            error: null,
            configVersion: config.version,
            createdAt: now,
          });
          const updated = new Thread({
            ...thread,
            title: thread.title === DEFAULT_THREAD_TITLE ? titleFromPrompt(prompt) : thread.title,
            updatedAt: now,
          });
          if (!(yield* saveReply(assistantMessage))) return null;
          yield* saveThread(updated);
          busy.add(thread.id);
          // Registered before the turn starts, so a stop sent right away still reaches it.
          const reply: Reply = { current: yield* Ref.make(assistantMessage), lock: yield* Semaphore.make(1) };
          replies.set(thread.id, reply);
          // The drain is forked outside the turn: it waits for the hob's lock, which a retirement
          // may hold while it waits for this very turn to stop.
          yield* FiberMap.run(
            turns,
            thread.id,
            runTurn(config, updated, prompt, reply).pipe(Effect.ensuring(Effect.forkIn(drain(thread.id), scope))),
          );
          return assistantMessage;
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
          yield* beginTurn(thread.value, agent.value, started.content, (reply) => saveStarted(started, reply));
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

      const sendPrompt = Effect.fn("ChatService.sendPrompt")(function* (threadId: ThreadId, content: string) {
        const { agentId } = yield* findThread(threadId);
        // The status check and the turn's registration happen under the hob's lock, so a turn is
        // either admitted before a retirement (which then sees and stops it) or refused after it.
        return yield* admission.withHob(
          agentId,
          Effect.gen(function* () {
            const thread = yield* findThread(threadId);
            const agent = yield* repo.findAgent(thread.agentId).pipe(Effect.map(Option.getOrThrow));
            yield* requireActive(agent);
            // A message waits while a reply runs, and behind any message already waiting, so the
            // thread's messages start in the order they were sent (CH-008).
            const waits = busy.has(threadId) || Option.isSome(yield* repo.nextQueuedMessage(threadId));
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
            yield* saveMessage(userMessage);
            if (waits) return { userMessage, assistantMessage: null };
            const assistantMessage = yield* beginTurn(thread, agent, content);
            return { userMessage, assistantMessage };
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

      const activeThreads = Effect.sync(() => Array.from(turns, ([threadId]) => threadId));

      const interruptAgent = Effect.fn("ChatService.interruptAgent")(function* (agentId: AgentId) {
        for (const threadId of yield* activeThreads) {
          const thread = yield* repo.findThread(threadId);
          if (Option.isSome(thread) && thread.value.agentId === agentId) yield* FiberMap.remove(turns, threadId);
        }
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
        interruptAgent,
        drainAgent,
        activeThreads,
      });
    }),
  );
}
