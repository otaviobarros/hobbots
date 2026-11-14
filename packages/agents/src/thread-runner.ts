import {
  type Agent,
  type AgentConfiguration,
  type AgentId,
  type BackpackTurnEnd,
  type Brain,
  DEFAULT_THREAD_TITLE,
  hobActor,
  hobReads,
  isInProgress,
  type Line,
  lineKey,
  liveSession,
  Message,
  MessageId,
  type MessageStatus,
  mainLine,
  QueuedMessageTransitions,
  replyActivity,
  systemInstructions,
  Thread,
  type ThreadId,
  ThreadLifecycle,
  type ThreadRunStatus,
  type TurnRequestId,
  TurnRequests,
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
import { makePackSources } from "./turn-pack.ts";
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
  /**
   * Starts a queued message together with its reply, the requests the turn answers taking the floor
   * with it; null when the message or a request no longer waits.
   */
  readonly saveStarted: (
    message: Message,
    reply: Message,
    speaking: ReadonlyArray<TurnRequestId>,
  ) => Effect.Effect<Message | null>;
  /** Saves a turn's new reply, the requests it answers taking the floor with it; null when one no longer waits. */
  readonly saveSpeaking: (reply: Message, speaking: ReadonlyArray<TurnRequestId>) => Effect.Effect<Message | null>;
}

export const makeThreadRunner = (deps: ThreadRunnerDeps) =>
  Effect.gen(function* () {
    const { redactor, grants, inputs, saveMessage, announce, changeThread, saveStarted, saveSpeaking } = deps;
    const { brief, instructionsChanged } = inputs;
    const repo = yield* HobbotsRepository;
    const packSources = yield* makePackSources;
    const bus = yield* EventPublisher;
    const admission = yield* HobAdmission;
    // Without a backpack, a thread starts only your queued messages.
    const continuations = yield* Effect.serviceOption(Continuations);
    // After a restore nothing that waited starts on its own until you resume work (ADR 026).
    const held = yield* workHeld;
    const scope = yield* Effect.scope;
    const turns = yield* FiberMap.make<ThreadId>();
    // Every line's run (ADR 037, ADR 039), changed only through `ThreadRunMachine`, keyed by
    // `lineKey`. In memory, as turns are; what waits is the stored `TurnRequest`s and backpack items.
    // A line with no entry is idle. `revision` counts every transition, so clients can order what
    // each publishes. Every turn runs in a thread's main line until reply threads come (#1472).
    interface LineRun {
      readonly line: Line;
      readonly run: ThreadRun;
    }
    interface Runs {
      readonly all: HashMap.HashMap<string, LineRun>;
      readonly revision: number;
    }
    const runs = yield* Ref.make<Runs>({ all: HashMap.empty(), revision: 0 });
    interface StepResult {
      readonly before: ThreadRun;
      readonly taken: boolean;
    }
    const runIn = (all: Runs["all"], line: Line) =>
      Option.match(HashMap.get(all, lineKey(line)), { onNone: () => idleRun, onSome: ({ run }) => run });
    const runOf = (threadId: ThreadId) => Ref.get(runs).pipe(Effect.map(({ all }) => runIn(all, mainLine(threadId))));
    // Applies an event to the line's run: `taken` says whether its rules allowed it, and `before`
    // is the run it found. A run back at rest is dropped, so the map holds only what is remembered.
    // Every transition taken is published once as `ThreadRunChanged`, after the change.
    const step = (threadId: ThreadId, event: ThreadRunEvent) =>
      Ref.modify(runs, (current): readonly [StepResult & { readonly published: ThreadRunStatus | null }, Runs] => {
        const line = mainLine(threadId);
        const before = runIn(current.all, line);
        const after = ThreadRunMachine.transition(before, event);
        if (typeof after === "string") return [{ before, taken: false, published: null }, current];
        const revision = current.revision + 1;
        const key = lineKey(line);
        const all = isAtRest(after)
          ? HashMap.remove(current.all, key)
          : HashMap.set(current.all, key, { line, run: after });
        return [
          { before, taken: true, published: runStatus(line, after, revision) },
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
          // Written by the hob that speaks, which in a camp need not be the thread's first hob.
          actor: hobActor(agent.id),
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
        // A note to self never reaches a turn (ADR 037).
        const transcript = (yield* repo.listMessages(thread.id)).filter((m) => m.status !== "queued" && hobReads(m));
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
        // A new session starts from the context pack; a resumed one hears what other brains wrote in
        // the live chapter since. Only the live chapter is ever replayed (ADR 037).
        const inChapter = before.filter((m) => m.chapterId === thread.liveChapterId);
        const told = switched ? [...inChapter, continued] : inChapter;
        const briefed = yield* brief(thread, brain.runtime, agent.id, told, switched);
        const pack =
          liveSession(thread, brain.runtime, agent.id) === undefined ? yield* packSources(thread, told, before) : null;
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
        // Who waits behind it is published first, so the turn's start says who is next.
        yield* lineUp(thread.id);
        yield* must(thread.id, { _tag: "Launch", hobId: agent.id, reply, activity: replyActivity(saved) });
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
            { text: briefing, pack },
            reply,
            changed,
            start.carry ?? NOTHING_CARRIED,
            // The message of yours the reply answers, as you wrote it, which Continue keeps (#1005).
            saved.promptId === null ? undefined : transcript.find((m) => m.id === saved.promptId),
          ).pipe(
            // However the turn ended, the requests it spoke for are answered before the floor frees.
            Effect.ensuring(repo.answerTurnRequests(saved.id)),
            Effect.ensuring(start.drain === false ? Effect.void : Effect.forkIn(drain(thread.id), scope)),
          ),
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

    // Publishes who waits for the line's floor, from its requests as stored now.
    const lineUp = (threadId: ThreadId) =>
      Effect.gen(function* () {
        const waiting = TurnRequests.waiting(yield* repo.openTurnRequests(mainLine(threadId)));
        yield* step(threadId, { _tag: "Lined", next: [...new Set(waiting.map((request) => request.hobId))] });
      });

    // The hobs among `hobIds` that take work now, by id.
    const activeHobs = (hobIds: ReadonlyArray<AgentId>) =>
      Effect.gen(function* () {
        const found = yield* Effect.forEach([...new Set(hobIds)], (hobId) => repo.findAgent(hobId));
        return new Map(
          found.flatMap((agent) =>
            Option.isSome(agent) && agent.value.status === "active" ? [[agent.value.id, agent.value] as const] : [],
          ),
        );
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

    // Whether a request of `agentId` waits in the thread's line, for routine progress to ride along.
    const requestWaitsFor = (threadId: ThreadId, agentId: AgentId) =>
      repo
        .openTurnRequests(mainLine(threadId))
        .pipe(Effect.map((open) => TurnRequests.waiting(open).some((request) => request.hobId === agentId)));

    // Gives the line's floor to the next request (ADR 039): the oldest waiting one whose hob takes
    // work, the message Send now picked first; with `only`, a request of that hob alone. Runs under
    // the thread's lock while the line is not busy. The request takes the floor together with its
    // turn's reply, and a queued message starts with them, so a crash cannot leave one without the
    // others.
    const startQueued = (threadId: ThreadId, start: TurnStart = {}, only: AgentId | null = null) =>
      Effect.gen(function* () {
        if (yield* held) return null;
        const found = yield* repo.findThread(threadId);
        if (Option.isNone(found)) return null;
        const open = yield* repo.openTurnRequests(mainLine(threadId));
        const hobs = yield* activeHobs(TurnRequests.waiting(open).map((request) => request.hobId));
        const { chosen } = yield* runOf(threadId);
        const next = TurnRequests.next(
          open,
          (request) => hobs.has(request.hobId) && (only === null || request.hobId === only),
          chosen,
        );
        yield* step(threadId, { _tag: "Unchoose", messageId: null });
        const agent = next === null ? undefined : hobs.get(next.hobId);
        // Nobody waiting can speak now: the line still says who waits, as after a restart.
        if (next === null || agent === undefined) return yield* lineUp(threadId).pipe(Effect.as(null));
        const message = yield* repo.findMessage(next.messageId);
        if (Option.isNone(message)) return null;
        // A queued message starts with its first request's turn; a message already said, as one
        // that several hobs owe, is the prompt of each later one.
        const started = QueuedMessageTransitions.start(message.value);
        return started instanceof Message
          ? yield* beginTurn(found.value, agent, started, (reply) => saveStarted(started, reply, [next.id]), start)
          : yield* beginTurn(found.value, agent, message.value, (reply) => saveSpeaking(reply, [next.id]), start);
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
    // When no turn ran for it, the records are read again: work that arrived after the dispatch
    // looked starts another dispatch, and otherwise only a request can be waiting.
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
                  if (routineOnly && !(yield* requestWaitsFor(threadId, agentId))) return null;
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
            yield* must(threadId, { _tag: "Delivered" });
            const again = ran || (yield* workWaits(service, threadId, agentId));
            yield* again ? startNext(threadId) : Effect.asVoid(startQueued(threadId));
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
            // Work rides along only a request of the hob it is for.
            const queued = yield* startQueued(threadId, { ...start, context: work.text("context") }, agentId);
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
    // work arrives for its hob. A busy thread reads the records again once it is free.
    const drainThreads = (threadIds: ReadonlyArray<ThreadId>) =>
      Effect.forEach(threadIds, (threadId) =>
        repo.findThread(threadId).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.void,
              onSome: (thread) =>
                admission.withHob(
                  thread.agentId,
                  runOf(threadId).pipe(Effect.flatMap((run) => (isBusy(run) ? Effect.void : startNext(threadId)))),
                ),
            }),
          ),
        ),
      );

    // Whether work waits in the thread that a dispatch would deliver now: work that needs the hob,
    // or routine progress when a request of that hob is there for it to ride along.
    const workWaits = (service: Continuations["Service"], threadId: ThreadId, agentId: AgentId) =>
      Effect.gen(function* () {
        if ((yield* service.waiting(agentId)).includes(threadId)) return true;
        return (yield* requestWaitsFor(threadId, agentId)) && (yield* service.progressWaits(threadId, agentId));
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

    const activeThreads = Effect.sync(() => Array.from(turns, ([threadId]) => threadId));
    const threadRuns = Ref.get(runs).pipe(
      Effect.map(({ all, revision }) => ({
        revision,
        runs: Array.from(HashMap.values(all)).flatMap(({ line, run }) =>
          // An idle line still says who waits for the floor, so a client that reconnects sees it.
          isBusy(run) || run.next.length > 0 ? [runStatus(line, run, revision)] : [],
        ),
      })),
    );
    const streamingReplies = Effect.suspend(() =>
      Ref.get(runs).pipe(
        Effect.flatMap(({ all }) =>
          Effect.forEach(
            Array.from(HashMap.values(all)).flatMap(({ run }) => (run.reply === null ? [] : [run.reply])),
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
      lineUp,
      drainThreads,
      endTurn,
      workRidesAlong,
      activeThreads,
      threadRuns,
      streamingReplies,
    } as const;
  });
