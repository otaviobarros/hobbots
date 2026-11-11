import {
  type Agent,
  type AgentConfiguration,
  type AgentId,
  type BackpackTurnEnd,
  type Brain,
  DEFAULT_THREAD_TITLE,
  isInProgress,
  Message,
  MessageId,
  type MessageStatus,
  QueuedMessageTransitions,
  replyActivity,
  systemInstructions,
  Thread,
  type ThreadId,
  ThreadLifecycle,
  type ThreadRunStatus,
  titleFromPrompt,
} from "@hobbots/domain";
import { DateTime, Deferred, Effect, Fiber, FiberMap, HashMap, Option, Ref, Semaphore } from "effect";
import { HobAdmission } from "./admission.ts";
import { type CarriedEnd, type CarriedWork, Continuations } from "./continuations.ts";
import { EventPublisher } from "./ports.ts";
import { HobbotsRepository } from "./repository.ts";
import { stoppedCommands, uncertainCalls } from "./steps.ts";
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
import type { makeTurnInputs } from "./turn-inputs.ts";
import { type Carry, makeTurnRunner, type TurnRunnerDeps } from "./turn-runner.ts";
import { workHeld } from "./work-hold.ts";

// Every thread's run (#1397): when its turns start and end, what queued behind them, and the work
// the backpack carries into them. ChatService decides what you asked for; this runs it.

const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

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

/** How a turn that carried work ended early, as a code: a reply still running was interrupted. */
const turnEnd = (status: MessageStatus): BackpackTurnEnd =>
  status === "failed" || status === "stopped" || status === "limited" ? status : "interrupted";

/** The brain a thread's turn thinks with: the thread's own, else the hob's configuration's. */
export const brainFor = (thread: Thread, config: AgentConfiguration): Brain =>
  thread.brain ?? { runtime: config.runtime, model: config.model, effort: config.effort };

/** What the thread runner takes from ChatService: the writes it announces, and what a turn starts with. */
export interface ThreadRunnerDeps
  extends Pick<TurnRunnerDeps, "redactor" | "grants" | "saveMessage" | "announce" | "changeThread"> {
  readonly inputs: Effect.Success<ReturnType<typeof makeTurnInputs>>;
  /** Starts a queued message together with its reply; null when the message no longer waits. */
  readonly saveStarted: (message: Message, reply: Message) => Effect.Effect<Message | null>;
}

export const makeThreadRunner = (deps: ThreadRunnerDeps) =>
  Effect.gen(function* () {
    const { redactor, grants, inputs, saveMessage, announce, changeThread, saveStarted } = deps;
    const { brief, instructionsChanged } = inputs;
    const repo = yield* HobbotsRepository;
    const bus = yield* EventPublisher;
    const admission = yield* HobAdmission;
    // Without a backpack, a thread starts only your queued messages.
    const continuations = yield* Effect.serviceOption(Continuations);
    // After a restore nothing that waited starts on its own until you resume work (ADR 026).
    const held = yield* workHeld;
    const scope = yield* Effect.scope;
    const turns = yield* FiberMap.make<ThreadId>();
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
        const all = isAtRest(after) ? HashMap.remove(current.all, threadId) : HashMap.set(current.all, threadId, after);
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

    const { runTurn } = yield* makeTurnRunner({
      redactor,
      grants,
      inputs,
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
        // Only the live chapter is replayed, and only on a brain switch (ADR 037).
        const inChapter = before.filter((m) => m.chapterId === thread.liveChapterId);
        const briefed = yield* brief(thread, brain.runtime, switched ? [...inChapter, continued] : inChapter, switched);
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

    // Whether your next message carries work: work you stopped in the thread, or routine
    // progress, which reaches the hob only as a digest along its next turn (IN-005).
    const workRidesAlong = (threadId: ThreadId, agentId: AgentId) =>
      Effect.gen(function* () {
        if (Option.isNone(continuations)) return false;
        const service = continuations.value;
        if ((yield* runOf(threadId)).held && (yield* service.waiting(agentId)).includes(threadId)) return true;
        return yield* service.progressWaits(threadId, agentId);
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

    /** Stops the thread's running turn, if any, and returns once it has ended. */
    const endTurn = (threadId: ThreadId) => FiberMap.remove(turns, threadId);

    return {
      runOf,
      step,
      transition,
      beginTurn,
      launch,
      startNext,
      drainThreads,
      endTurn,
      workRidesAlong,
      activeThreads,
      threadRuns,
      streamingReplies,
    } as const;
  });
