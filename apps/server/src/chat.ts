import { AgentNotFound, ThreadBusy, ThreadNotFound } from "@hobbots/api";
import {
  type Agent,
  type AgentId,
  DEFAULT_THREAD_TITLE,
  Message,
  MessageId,
  MessageTransitions,
  Thread,
  ThreadId,
  titleFromPrompt,
} from "@hobbots/domain";
import { HobbotsRepository } from "@hobbots/persistence";
import { RuntimeAdapter, type RuntimeEvent } from "@hobbots/runtimes";
import { Context, DateTime, Effect, FiberMap, Layer, Option, Ref, Stream } from "effect";
import { EventBus } from "./event-bus.ts";

const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

export class ChatService extends Context.Service<
  ChatService,
  {
    readonly createThread: (agentId: AgentId) => Effect.Effect<Thread, AgentNotFound>;
    readonly sendPrompt: (
      threadId: ThreadId,
      content: string,
    ) => Effect.Effect<{ userMessage: Message; assistantMessage: Message }, ThreadNotFound | ThreadBusy>;
    readonly interrupt: (threadId: ThreadId) => Effect.Effect<void, ThreadNotFound>;
  }
>()("@hobbots/server/ChatService") {
  static readonly layer = Layer.effect(
    ChatService,
    Effect.gen(function* () {
      const repo = yield* HobbotsRepository;
      const bus = yield* EventBus;
      const runtime = yield* RuntimeAdapter;
      const turns = yield* FiberMap.make<ThreadId>();

      // A previous process may have died mid-turn; those turns cannot resume.
      for (const message of yield* repo.interruptStaleMessages) {
        yield* bus.publish({ _tag: "MessageUpserted", message });
      }

      const findThread = (threadId: ThreadId) =>
        repo.findThread(threadId).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.fail(new ThreadNotFound({ threadId })),
              onSome: Effect.succeed,
            }),
          ),
        );

      const saveThread = (thread: Thread) =>
        repo.upsertThread(thread).pipe(Effect.andThen(bus.publish({ _tag: "ThreadUpserted", thread })));

      const saveMessage = (message: Message) =>
        repo.upsertMessage(message).pipe(Effect.andThen(bus.publish({ _tag: "MessageUpserted", message })));

      const createThread = Effect.fn("ChatService.createThread")(function* (agentId: AgentId) {
        const agent = yield* repo.findAgent(agentId);
        if (Option.isNone(agent)) return yield* new AgentNotFound({ agentId });
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
      });

      const runTurn = (agent: Agent, thread: Thread, prompt: string, assistant: Message) =>
        Effect.gen(function* () {
          const current = yield* Ref.make(assistant);
          const threadRef = yield* Ref.make(thread);

          // Domain transitions reject changes to finished messages; ignore late runtime events.
          const transition = (f: (message: Message) => Message | unknown) =>
            Ref.get(current).pipe(
              Effect.map(f),
              Effect.flatMap((next) =>
                next instanceof Message
                  ? Ref.set(current, next).pipe(Effect.as(Option.some(next)))
                  : Effect.succeed(Option.none<Message>()),
              ),
            );

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
                return transition((m) => MessageTransitions.appendDelta(m, event.text)).pipe(
                  Effect.flatMap(
                    Option.match({
                      onNone: () => Effect.void,
                      onSome: (m) =>
                        bus.publish({
                          _tag: "MessageDelta",
                          threadId: m.threadId,
                          messageId: m.id,
                          delta: event.text,
                        }),
                    }),
                  ),
                );
              case "Completed":
                return transition((m) => MessageTransitions.complete(m, event.text)).pipe(
                  Effect.flatMap(
                    Option.match({
                      onNone: () => Effect.void,
                      onSome: saveMessage,
                    }),
                  ),
                );
            }
          };

          yield* runtime
            .sendPrompt({
              prompt,
              sessionId: thread.runtimeSessionId,
              instructions: agent.instructions,
              model: agent.model,
            })
            .pipe(
              Stream.runForEach(handle),
              Effect.catchTag("RuntimeError", (error) =>
                transition((m) => MessageTransitions.fail(m, error.message)).pipe(
                  Effect.flatMap(
                    Option.match({
                      onNone: () => Effect.void,
                      onSome: saveMessage,
                    }),
                  ),
                ),
              ),
              Effect.onInterrupt(() =>
                transition(MessageTransitions.interrupt).pipe(
                  Effect.flatMap(
                    Option.match({
                      onNone: () => Effect.void,
                      onSome: saveMessage,
                    }),
                  ),
                ),
              ),
            );
          // The stream ended without a result: treat it as a failure, not a silent success.
          yield* transition((m) => MessageTransitions.fail(m, "Runtime ended without a result")).pipe(
            Effect.flatMap(Option.match({ onNone: () => Effect.void, onSome: saveMessage })),
          );
        });

      const sendPrompt = Effect.fn("ChatService.sendPrompt")(function* (threadId: ThreadId, content: string) {
        const thread = yield* findThread(threadId);
        if (yield* FiberMap.has(turns, threadId)) return yield* new ThreadBusy({ threadId });
        const agent = yield* repo.findAgent(thread.agentId).pipe(Effect.map(Option.getOrThrow));
        const now = yield* nowIso;

        const userMessage = new Message({
          id: MessageId.make(crypto.randomUUID()),
          threadId,
          role: "user",
          content,
          status: "complete",
          error: null,
          createdAt: now,
        });
        const assistantMessage = new Message({
          id: MessageId.make(crypto.randomUUID()),
          threadId,
          role: "assistant",
          content: "",
          status: "streaming",
          error: null,
          createdAt: now,
        });
        const updated = new Thread({
          ...thread,
          title: thread.title === DEFAULT_THREAD_TITLE ? titleFromPrompt(content) : thread.title,
          updatedAt: now,
        });

        yield* saveMessage(userMessage);
        yield* saveMessage(assistantMessage);
        yield* saveThread(updated);
        yield* FiberMap.run(turns, threadId, runTurn(agent, updated, content, assistantMessage));
        return { userMessage, assistantMessage };
      });

      const interrupt = Effect.fn("ChatService.interrupt")(function* (threadId: ThreadId) {
        yield* findThread(threadId);
        yield* FiberMap.remove(turns, threadId);
      });

      return ChatService.of({ createThread, sendPrompt, interrupt });
    }),
  );
}
